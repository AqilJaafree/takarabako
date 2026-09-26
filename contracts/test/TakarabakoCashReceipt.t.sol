// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {TakarabakoCashReceipt} from "../src/TakarabakoCashReceipt.sol";

contract TakarabakoCashReceiptTest is Test {
    TakarabakoCashReceipt tk;

    address treasury = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    bytes32 constant KIOSK = "tokyo-01";
    bytes32 constant OTHER = "penang-02";
    bytes3 constant MYR = "MYR";

    uint256 constant ONE = 1e6; // 6 decimals, like USDC

    function setUp() public {
        tk = new TakarabakoCashReceipt(treasury);
        tk.setKiosk(KIOSK, true);
        tk.setKiosk(OTHER, true);
    }

    function test_cashInMintsAndKeepsSupplyEqualToReserve() public {
        tk.recordCashIn(KIOSK, alice, 21 * ONE, 100, MYR);
        tk.recordCashIn(OTHER, bob, 5 * ONE, 5, "USD");

        assertEq(tk.balanceOf(alice), 21 * ONE);
        (, , uint256 reserve,) = tk.kiosks(KIOSK);
        assertEq(reserve, 21 * ONE);
        assertEq(tk.totalReserve(), 26 * ONE);
        assertEq(tk.totalSupply(), tk.totalReserve());
    }

    function test_cashInEmitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit TakarabakoCashReceipt.CashIn(KIOSK, alice, 21 * ONE, 100, MYR);
        tk.recordCashIn(KIOSK, alice, 21 * ONE, 100, MYR);
    }

    function test_cashInRevertsForInactiveKiosk() public {
        vm.expectRevert(abi.encodeWithSelector(TakarabakoCashReceipt.KioskNotActive.selector, bytes32("nowhere")));
        tk.recordCashIn("nowhere", alice, ONE, 1, MYR);
    }

    function test_redeemBurnsAndReducesReserve() public {
        tk.recordCashIn(KIOSK, alice, 20 * ONE, 100, MYR);
        tk.redeem(KIOSK, alice, 8 * ONE);

        assertEq(tk.balanceOf(alice), 12 * ONE);
        (, , uint256 reserve,) = tk.kiosks(KIOSK);
        assertEq(reserve, 12 * ONE);
        assertEq(tk.totalSupply(), tk.totalReserve());
    }

    function test_redeemCannotExceedKioskReserve() public {
        tk.recordCashIn(KIOSK, alice, 5 * ONE, 20, MYR);
        tk.recordCashIn(OTHER, alice, 5 * ONE, 20, MYR);
        vm.expectRevert(
            abi.encodeWithSelector(TakarabakoCashReceipt.InsufficientReserve.selector, KIOSK, 5 * ONE, 6 * ONE)
        );
        tk.redeem(KIOSK, alice, 6 * ONE);
    }

    function test_transferBetweenAllowlisted() public {
        tk.recordCashIn(KIOSK, alice, 10 * ONE, 50, MYR);
        tk.setAllowlisted(alice, true);
        tk.setAllowlisted(bob, true);

        vm.prank(alice);
        tk.transfer(bob, 4 * ONE);
        assertEq(tk.balanceOf(bob), 4 * ONE);
    }

    function test_transferToNonAllowlistedReverts() public {
        tk.recordCashIn(KIOSK, alice, 10 * ONE, 50, MYR);
        tk.setAllowlisted(alice, true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TakarabakoCashReceipt.NotAllowlisted.selector, bob));
        tk.transfer(bob, ONE);
    }

    function test_transferFromNonAllowlistedReverts() public {
        tk.recordCashIn(KIOSK, alice, 10 * ONE, 50, MYR);
        tk.setAllowlisted(bob, true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TakarabakoCashReceipt.NotAllowlisted.selector, alice));
        tk.transfer(bob, ONE);
    }

    function test_dailyLimitRevertsThenResetsNextDay() public {
        tk.recordCashIn(KIOSK, alice, 100 * ONE, 100, MYR);
        tk.setAllowlisted(alice, true);
        tk.setAllowlisted(bob, true);
        tk.setDailyTransferLimit(10 * ONE);

        vm.startPrank(alice);
        tk.transfer(bob, 6 * ONE);
        vm.expectRevert(
            abi.encodeWithSelector(TakarabakoCashReceipt.DailyLimitExceeded.selector, alice, 11 * ONE, 10 * ONE)
        );
        tk.transfer(bob, 5 * ONE);

        vm.warp(block.timestamp + 1 days);
        tk.transfer(bob, 10 * ONE);
        vm.stopPrank();
        assertEq(tk.balanceOf(bob), 16 * ONE);
    }

    function test_attestationMatchKeepsKioskOpen() public {
        tk.recordCashIn(KIOSK, alice, 10 * ONE, 50, MYR);
        tk.attestReserve(KIOSK, 10 * ONE, "audit-1");

        (, bool frozen,, uint64 lastAuditAt) = tk.kiosks(KIOSK);
        assertFalse(frozen);
        assertEq(lastAuditAt, block.timestamp);
    }

    function test_attestationMismatchFreezesKiosk() public {
        tk.recordCashIn(KIOSK, alice, 10 * ONE, 50, MYR);

        vm.expectEmit(true, false, false, true);
        emit TakarabakoCashReceipt.ReserveAttested(KIOSK, 9 * ONE, 10 * ONE, -int256(ONE), "audit-2");
        tk.attestReserve(KIOSK, 9 * ONE, "audit-2");

        (, bool frozen,,) = tk.kiosks(KIOSK);
        assertTrue(frozen);
        vm.expectRevert(abi.encodeWithSelector(TakarabakoCashReceipt.KioskIsFrozen.selector, KIOSK));
        tk.recordCashIn(KIOSK, alice, ONE, 1, MYR);

        // Other kiosks keep working, and cash can still leave the frozen one.
        tk.recordCashIn(OTHER, alice, ONE, 1, MYR);
        tk.redeem(KIOSK, alice, ONE);

        tk.unfreezeKiosk(KIOSK);
        tk.recordCashIn(KIOSK, alice, ONE, 1, MYR);
    }

    function test_onlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        tk.recordCashIn(KIOSK, alice, ONE, 1, MYR);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        tk.redeem(KIOSK, alice, 0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        tk.attestReserve(KIOSK, 0, "x");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        tk.setAllowlisted(alice, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        tk.pause();
        vm.stopPrank();
    }

    function test_pauseBlocksTransfersAndCashInButNotRedeem() public {
        tk.recordCashIn(KIOSK, alice, 10 * ONE, 50, MYR);
        tk.setAllowlisted(alice, true);
        tk.setAllowlisted(bob, true);
        tk.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        tk.transfer(bob, ONE);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        tk.recordCashIn(KIOSK, alice, ONE, 1, MYR);

        tk.redeem(KIOSK, alice, ONE);
        assertEq(tk.balanceOf(alice), 9 * ONE);

        tk.unpause();
        vm.prank(alice);
        tk.transfer(bob, ONE);
    }

    function testFuzz_supplyAlwaysEqualsReserve(uint96 inA, uint96 inB, uint96 out) public {
        tk.recordCashIn(KIOSK, alice, inA, 1, MYR);
        tk.recordCashIn(OTHER, bob, inB, 1, MYR);
        uint256 burn = bound(out, 0, inA);
        tk.redeem(KIOSK, alice, burn);
        assertEq(tk.totalSupply(), tk.totalReserve());
    }
}
