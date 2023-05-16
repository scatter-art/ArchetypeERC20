import { ethers } from 'hardhat';
import { expect } from 'chai';

import {
    DEPLOYMENT_TIME,
    OptPartialApplierRes,
    conditionalPartialApplier,
    getRandomFundedAccount,
    rewardingForHoldingFactory
} from '../scripts/helpers'
import { RewardsDistributor } from '../typechain-types';
import { getLastTimestamp, sleep, toWei, fromWei } from '../lib/ArchetypeAuction/scripts/helpers';
import { snd } from 'fp-ts/lib/ReadonlyTuple';

describe('RewardsDistributor', async () => {

    let nftAndRewardTokenFactory: OptPartialApplierRes<typeof rewardingForHoldingFactory>
    let REWARDS_DISTRIBUTOR: RewardsDistributor

    before(async () => {
        // NOTE that all tests should work using the same `rewardsDistributor`, as it
        // is an singleton.
        const USE_SAME_REWARDS_DISTRIBUTOR_FOR_ALL_TESTS = true;

        REWARDS_DISTRIBUTOR = await ethers.getContractFactory('RewardsDistributor')
            .then(f => f.deploy())

        nftAndRewardTokenFactory = conditionalPartialApplier(
            USE_SAME_REWARDS_DISTRIBUTOR_FOR_ALL_TESTS, rewardingForHoldingFactory
        )({ rewardsDistributor: REWARDS_DISTRIBUTOR })
    })

    /**
     * @dev System case analyzed in this `describe` block:
     * - It's using an already existing erc20 token as rewards, that means that the
     *   erc20 owner has to fund the contract so the reward distributions work.
     * - It's using an already existing erc721 token, that means that the NFT owners
     *   have to call `enableNftRewardsFor` so they can use that token for rewards.
     */
    describe('distributing rewards for holding already existing nfts', async () => {

        describe('contract configuration', async () => {
            it('should have nft address right configured', async () => {
                const { rewardsDistributor, erc20, nft } = await nftAndRewardTokenFactory({})
                const conf = await rewardsDistributor.nftHoldingRewardsConfigFor(erc20.address)
                expect(conf.nftContract).to.equal(nft.address)
            })
            it('should have reward model enabled', async () => {
                const { rewardsDistributor, erc20 } = await nftAndRewardTokenFactory({})
                const conf = await rewardsDistributor.nftHoldingRewardsConfigFor(erc20.address)
                expect(conf.isEnabled).to.equal(true)
            })
            it('should have rewards per day correctly configured', async () => {
                const { rewardsDistributor, erc20 } = await nftAndRewardTokenFactory({
                    rewardsPerSecond: 30
                })
                const conf = await rewardsDistributor.nftHoldingRewardsConfigFor(erc20.address)
                expect(conf.rewardsWeightPerDay).to.equal(toWei(30 * 60 * 60 * 24))
            })
            it('should have rewarding started after configuration', async () => {
                const { rewardsDistributor, erc20 } = await nftAndRewardTokenFactory({})
                const expectedStart = await getLastTimestamp()
                const conf = await rewardsDistributor.nftHoldingRewardsConfigFor(erc20.address)
                expect(expectedStart).to.equal(conf.rewardsDistributionStarted)
            })

        })

        it('shouldn\'t allow claiming rewards if contract is empty', async () => {
            const { rewardsDistributor, erc20, nft, owner } = await nftAndRewardTokenFactory({})

            const rewardedUser = await getRandomFundedAccount()
            await nft.connect(owner).mint(rewardedUser.address, 1)

            expect(await nft.balanceOf(rewardedUser.address)).to.equal(1)
            expect(await nft.ownerOf(1)).to.equal(rewardedUser.address)
            await sleep(1)
            expect(
                rewardsDistributor.connect(rewardedUser).claimRewardsForNftsHeld(erc20.address, [1])
            ).to.be.reverted
        })

        it('shouldn\'t allow claiming rewards if contract is almost empty', async () => {
            const { rewardsDistributor, erc20, nft, owner } = await nftAndRewardTokenFactory({
                rewardsPerSecond: 30
            })

            const rewardedUser = await getRandomFundedAccount()
            await nft.connect(owner).mint(rewardedUser.address, 1)
            await erc20.connect(owner).transfer(rewardsDistributor.address, toWei(15))

            expect(await erc20.balanceOf(rewardsDistributor.address)).to.equal(toWei(15))
            await sleep(1)
            expect(
                rewardsDistributor.connect(rewardedUser).claimRewardsForNftsHeld(erc20.address, [1])
            ).to.be.reverted
            expect(await erc20.balanceOf(rewardsDistributor.address)).to.equal(toWei(15))
        })

        it('should be able to calc deserved rewards', async () => {
            const rewardsPerSecond = 1
            const { 
                rewardsDistributor, erc20, nft, owner 
            } = await nftAndRewardTokenFactory({rewardsPerSecond})
            const iniTime = await getLastTimestamp()

            const rewardedUser = await getRandomFundedAccount()
            await nft.connect(owner).mint(rewardedUser.address, 1)

            await sleep(2)

            const rewards = await rewardsDistributor.calcNftHoldingRewards(erc20.address, [1])
            const expectedRewards = (await getLastTimestamp() - iniTime) * rewardsPerSecond
            expect(rewards).to.equal(toWei(expectedRewards))
        })

        it('shouldn\'t have low rewards for recently minted nfts', async () => {
            const rewardsPerSecond = 1
            const { 
                rewardsDistributor, erc20, nft, owner
            } = await nftAndRewardTokenFactory({rewardsPerSecond})
            const iniTime = await getLastTimestamp()

            await erc20.connect(owner).transfer(rewardsDistributor.address, toWei(15))
            const hacker = await getRandomFundedAccount()

            await sleep(2)

            await nft.connect(owner).mint(hacker.address, 1)
            await rewardsDistributor.connect(hacker).claimRewardsForNftsHeld(erc20.address, [1])
            
            const expectedBalance = (await getLastTimestamp() - iniTime) * rewardsPerSecond

            expect(await erc20.balanceOf(hacker.address)).to.equal(toWei(expectedBalance))
        })

        it('shouldn\'t be able to claim same id twice in same tx', async () => {
            const rewardsPerSecond = 1
            const { 
                rewardsDistributor, erc20, nft, owner
            } = await nftAndRewardTokenFactory({rewardsPerSecond})
            const iniTime = await getLastTimestamp()

            await erc20.connect(owner).transfer(rewardsDistributor.address, toWei(15))
            const hacker = await getRandomFundedAccount()
            await nft.connect(owner).mint(hacker.address, 1)

            await sleep(1)

            await rewardsDistributor.connect(hacker).claimRewardsForNftsHeld(
                erc20.address, new Array(10).fill(1)
            )

            const expectedBalance = (await getLastTimestamp() - iniTime) * rewardsPerSecond
            expect(await erc20.balanceOf(hacker.address)).to.equal(toWei(expectedBalance))
        })

        it('should have claim time updated', async () => {
            const rewardsPerSecond = 1
            const { 
                rewardsDistributor, erc20, nft, owner
            } = await nftAndRewardTokenFactory({rewardsPerSecond})

            await erc20.connect(owner).transfer(rewardsDistributor.address, toWei(15))
            const rewardedUser=  await getRandomFundedAccount()
            await nft.connect(owner).mint(rewardedUser.address, 1)
            

            await rewardsDistributor.connect(rewardedUser).claimRewardsForNftsHeld(erc20.address, [1])
            const claimTime = await getLastTimestamp()
            expect(await rewardsDistributor.lastTimeClaimed(erc20.address, 1)).to.equal(claimTime)
            
        })

        it('shouldn\'t be able to claim same id mutiple times', async () => {
            const rewardsPerSecond = 1
            const { 
                rewardsDistributor, erc20, nft, owner
            } = await nftAndRewardTokenFactory({rewardsPerSecond, rewardTokenSupply: 300})
            const iniTime = await getLastTimestamp()

            await erc20.connect(owner).transfer(rewardsDistributor.address, toWei(300))
            const hacker = await getRandomFundedAccount()
            await nft.connect(owner).mint(hacker.address, 1)
            
            await sleep(5)
            await rewardsDistributor.connect(hacker).claimRewardsForNftsHeld(erc20.address, [1])
            
            const firstClaimTime = await getLastTimestamp()
            const expectedFirstClaim = (firstClaimTime - iniTime) * rewardsPerSecond
            const firstTimeBal = await erc20.balanceOf(hacker.address)
            expect(firstTimeBal).to.equal(toWei(expectedFirstClaim))

            await sleep(2)
            await rewardsDistributor.connect(hacker).claimRewardsForNftsHeld(erc20.address, [1])

            const expectedSecondClaim = (await getLastTimestamp() - firstClaimTime) * rewardsPerSecond
            expect(await erc20.balanceOf(hacker.address)).to.equal(
                toWei(expectedSecondClaim).add(firstTimeBal)
            )
        })

        it('shouldn\'t break on empty claim', async () => {
            const { rewardsDistributor, erc20, owner } = await nftAndRewardTokenFactory({})
            await erc20.connect(owner).transfer(rewardsDistributor.address, toWei(15))

            const hacker = await getRandomFundedAccount()
            await rewardsDistributor.connect(hacker).claimRewardsForNftsHeld(erc20.address, [])
            expect(await erc20.balanceOf(rewardsDistributor.address)).to.equal(toWei(15))
        })

        it('should allow rewards on multiple nfts', async () => {
            const rewardsPerSecond = 1
            const { 
                rewardsDistributor, erc20, nft, owner
            } = await nftAndRewardTokenFactory({rewardsPerSecond})
            const iniTime = await getLastTimestamp()

            await erc20.connect(owner).transfer(rewardsDistributor.address, toWei(30))
            const rewardedUser = await getRandomFundedAccount()
            const ownedIds = [1, 31, 59]

            for (const id of ownedIds)
                await nft.connect(owner).mint(rewardedUser.address, id)

            await sleep(2)

            await rewardsDistributor.connect(rewardedUser).claimRewardsForNftsHeld(
                erc20.address, ownedIds
            )

            const expectedRewards = (await getLastTimestamp() - iniTime) 
                * rewardsPerSecond * ownedIds.length

            expect(await erc20.balanceOf(rewardedUser.address)).to.equal(toWei(expectedRewards))
        })

        it('should allow multiple rewards on multiple nfts', async () => {
            const rewardsPerSecond = 3
            const { 
                rewardsDistributor, erc20, nft, owner
            } = await nftAndRewardTokenFactory({rewardsPerSecond, rewardTokenSupply: 600})
            const iniTime = await getLastTimestamp()

            await erc20.connect(owner).transfer(rewardsDistributor.address, toWei(600))

            const holder1 = await getRandomFundedAccount()
            const holder2 = await getRandomFundedAccount()
            const holder3 = await getRandomFundedAccount()

            const fromOwnerToIds: { [key: string]: number[] } = {
                [holder1.address]: [1, 13, 10],
                [holder2.address]: [34, 128],
                [holder3.address]: [7, 9]
            }

            for (const [addr, ids] of Object.entries(fromOwnerToIds))
                for (const id of ids)
                    await nft.connect(owner).mint(addr, id)

            await sleep(1)
            
            // Claiming for holder1
            await rewardsDistributor.connect(holder1).claimRewardsForNftsHeld(
                erc20.address, fromOwnerToIds[holder1.address]
            )
            
            const holder1claimTime = await getLastTimestamp()
            const expectedRewards1 = (holder1claimTime - iniTime) 
                * fromOwnerToIds[holder1.address].length * rewardsPerSecond
            const holder1firstBal = await erc20.balanceOf(holder1.address)
            expect(holder1firstBal).to.equal(toWei(expectedRewards1))
            
            // Claiming for holder2
            await rewardsDistributor.connect(holder2).claimRewardsForNftsHeld(
                erc20.address, fromOwnerToIds[holder2.address]
            )

            const expectedRewards2 = (await getLastTimestamp() - iniTime) 
                * fromOwnerToIds[holder2.address].length * rewardsPerSecond
            expect(await erc20.balanceOf(holder2.address)).to.equal(toWei(expectedRewards2))

            // Claiming for holder3
            await rewardsDistributor.connect(holder3).claimRewardsForNftsHeld(
                erc20.address, fromOwnerToIds[holder3.address]
            )

            const expectedRewards3 = (await getLastTimestamp() - iniTime) 
                * fromOwnerToIds[holder3.address].length * rewardsPerSecond
            expect(await erc20.balanceOf(holder3.address)).to.equal(toWei(expectedRewards3))

            // Claiming for holder1 again
            await rewardsDistributor.connect(holder1).claimRewardsForNftsHeld(
                erc20.address, fromOwnerToIds[holder1.address]
            )
                
            const finalRewards = (await getLastTimestamp() - holder1claimTime)
                * fromOwnerToIds[holder1.address].length * rewardsPerSecond
            expect(await erc20.balanceOf(holder1.address)).to.equal(
                toWei(finalRewards).add(holder1firstBal)
            )

        })
    })
})
