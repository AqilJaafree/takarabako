// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockJPYC} from "../src/mocks/MockJPYC.sol";
import {TakarabakoVault} from "../src/TakarabakoVault.sol";

contract TakarabakoVaultTest is Test {
    MockJPYC jpyc;
    TakarabakoVault vault;

    address treasury = address(this);
    address user = address(0xBEEF);
    address devWallet = address(0xD0DE);

    function setUp() public {
        jpyc = new MockJPYC(treasury);
        vault = new TakarabakoVault(jpyc, 420, treasury); // 4.20% APY

        jpyc.mint(treasury, 1_000_000 ether);
        jpyc.approve(address(vault), type(uint256).max);
    }

    function test_depositCreditsShares() public {
        uint256 shares = vault.depositFor(user, 1_000 ether);

        assertEq(shares, 1_000 ether, "1:1 shares at genesis exchange rate");
        assertEq(vault.sharesOf(user), 1_000 ether);
        assertEq(vault.previewValue(user), 1_000 ether);
    }

    function test_yieldAccruesOverTime() public {
        vault.depositFor(user, 1_000 ether);

        vm.warp(block.timestamp + 365 days);

        // ~4.20% simple accrual over a year.
        uint256 value = vault.previewValue(user);
        assertApproxEqRel(value, 1_042 ether, 0.001e18);
    }

    function test_withdrawSendsFundsToRecipientNotOwner() public {
        vault.depositFor(user, 1_000 ether);
        vault.fundYieldReserve(100 ether); // cover the accrued-yield buffer

        vm.warp(block.timestamp + 365 days);

        uint256 shares = vault.sharesOf(user);
        uint256 paid = vault.withdrawTo(user, devWallet, shares);

        assertEq(vault.sharesOf(user), 0, "shares burned from the user");
        assertEq(jpyc.balanceOf(devWallet), paid, "JPYC settles to the dev/treasury wallet, per PRD S6.6");
        assertEq(jpyc.balanceOf(user), 0, "no crypto sent directly to the user's own address in v1");
    }

    function test_onlyOwnerCanMoveShares() public {
        vm.prank(user);
        vm.expectRevert();
        vault.depositFor(user, 1 ether);
    }
}
