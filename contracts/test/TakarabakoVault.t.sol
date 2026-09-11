// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {TakarabakoVault} from "../src/TakarabakoVault.sol";

contract TakarabakoVaultTest is Test {
    MockUSDC usdc;
    TakarabakoVault vault;

    address treasury = address(this);
    address user = address(0xBEEF);
    address devWallet = address(0xD0DE);

    // USDC uses 6 decimals, not the usual 18 — see MockUSDC.sol.
    uint256 constant ONE_USDC = 1e6;

    function setUp() public {
        usdc = new MockUSDC(treasury);
        vault = new TakarabakoVault(usdc, 420, treasury); // 4.20% APY

        usdc.mint(treasury, 1_000_000 * ONE_USDC);
        usdc.approve(address(vault), type(uint256).max);
    }

    function test_depositCreditsShares() public {
        uint256 shares = vault.depositFor(user, 1_000 * ONE_USDC);

        assertEq(shares, 1_000 * ONE_USDC, "1:1 shares at genesis exchange rate");
        assertEq(vault.sharesOf(user), 1_000 * ONE_USDC);
        assertEq(vault.previewValue(user), 1_000 * ONE_USDC);
    }

    function test_yieldAccruesOverTime() public {
        vault.depositFor(user, 1_000 * ONE_USDC);

        vm.warp(block.timestamp + 365 days);

        // ~4.20% simple accrual over a year.
        uint256 value = vault.previewValue(user);
        assertApproxEqRel(value, 1_042 * ONE_USDC, 0.001e18);
    }

    function test_withdrawSendsFundsToRecipientNotOwner() public {
        vault.depositFor(user, 1_000 * ONE_USDC);
        vault.fundYieldReserve(100 * ONE_USDC); // cover the accrued-yield buffer

        vm.warp(block.timestamp + 365 days);

        uint256 shares = vault.sharesOf(user);
        uint256 paid = vault.withdrawTo(user, devWallet, shares);

        assertEq(vault.sharesOf(user), 0, "shares burned from the user");
        assertEq(usdc.balanceOf(devWallet), paid, "USDC settles to the dev/treasury wallet, per PRD S6.6");
        assertEq(usdc.balanceOf(user), 0, "no crypto sent directly to the user's own address in v1");
    }

    function test_onlyOwnerCanMoveShares() public {
        vm.prank(user);
        vm.expectRevert();
        vault.depositFor(user, 1 * ONE_USDC);
    }
}
