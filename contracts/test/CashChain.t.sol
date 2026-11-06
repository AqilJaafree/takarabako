// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {TakarabakoVault} from "../src/TakarabakoVault.sol";
import {TakarabakoCashReceipt} from "../src/TakarabakoCashReceipt.sol";

/// One chain's worth of Takarabako (vault + tkCASH) the way DeployCashChain.s.sol
/// sets it up, with the USDC at Arc's fixed address (0x3600…0000, 6 decimals as an
/// ERC-20). Covers the flows the bridge relies on: the treasury receives USDC it did
/// not mint here (a CCTP mint) and credits a customer's box with it.
contract CashChainTest is Test {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint256 constant ONE = 1e6;
    uint256 constant DAILY_LIMIT_USD = 1000;
    bytes32 constant KIOSK = "mumbai-01";

    address treasury = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    MockUSDC usdc;
    TakarabakoVault vault;
    TakarabakoCashReceipt tk;

    function setUp() public {
        // The same bytecode, living at Arc's USDC address.
        deployCodeTo("MockUSDC.sol:MockUSDC", abi.encode(treasury), ARC_USDC);
        usdc = MockUSDC(ARC_USDC);
        assertEq(usdc.decimals(), 6);

        vault = new TakarabakoVault(IERC20(ARC_USDC), 420, treasury);
        tk = new TakarabakoCashReceipt(treasury);
        tk.setKiosk(KIOSK, true);
        tk.setDailyTransferLimit(DAILY_LIMIT_USD * ONE);
        usdc.approve(address(vault), type(uint256).max);
    }

    function test_cashInCreditsVaultAndMintsTkcashOnTheSameChain() public {
        usdc.mint(treasury, 100 * ONE);
        vault.depositFor(alice, 25 * ONE);
        tk.recordCashIn(KIOSK, alice, 25 * ONE, 100, "MYR");

        assertEq(vault.previewValue(alice), 25 * ONE);
        assertEq(tk.balanceOf(alice), 25 * ONE);
        assertEq(tk.totalSupply(), tk.totalReserve());
        assertEq(usdc.balanceOf(address(vault)), 25 * ONE);
    }

    function test_bridgedUsdcCreditsTheBoxWithoutMintingTkcash() public {
        // A CCTP mint lands USDC with the treasury; the backend then credits the box.
        usdc.mint(treasury, 40 * ONE);
        uint256 supplyBefore = tk.totalSupply();
        vault.depositFor(alice, 40 * ONE);

        assertEq(vault.previewValue(alice), 40 * ONE);
        assertEq(tk.totalSupply(), supplyBefore, "bridging moves USDC, never tkCASH");
    }

    function test_boxCanBeWithdrawnToTheTreasuryForABridgeBurn() public {
        usdc.mint(treasury, 40 * ONE);
        vault.depositFor(alice, 40 * ONE);

        uint256 shares = vault.sharesOf(alice);
        uint256 before = usdc.balanceOf(treasury);
        vault.withdrawTo(alice, treasury, shares);

        assertEq(usdc.balanceOf(treasury) - before, 40 * ONE);
        assertEq(vault.sharesOf(alice), 0);
    }

    function test_uniformDailyLimitAppliesToEveryHolder() public {
        tk.setAllowlisted(alice, true);
        tk.setAllowlisted(bob, true);
        tk.recordCashIn(KIOSK, alice, 1_500 * ONE, 1, "USD");
        tk.recordCashIn(KIOSK, bob, 1_500 * ONE, 1, "USD");

        vm.prank(alice);
        tk.transfer(bob, 1_000 * ONE); // exactly the limit
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TakarabakoCashReceipt.DailyLimitExceeded.selector, alice, 1_001 * ONE, DAILY_LIMIT_USD * ONE));
        tk.transfer(bob, 1 * ONE);

        // bob has the same limit, no exceptions
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TakarabakoCashReceipt.DailyLimitExceeded.selector, bob, 1_001 * ONE, DAILY_LIMIT_USD * ONE));
        tk.transfer(alice, 1_001 * ONE);

        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        tk.transfer(bob, 1 * ONE); // a new day
    }

    function test_onlyAllowlistedWalletsHoldTransferredTkcash() public {
        tk.setAllowlisted(alice, true);
        tk.recordCashIn(KIOSK, alice, 10 * ONE, 1, "USD");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TakarabakoCashReceipt.NotAllowlisted.selector, bob));
        tk.transfer(bob, ONE);
    }
}
