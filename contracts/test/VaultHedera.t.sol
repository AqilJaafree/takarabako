// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TakarabakoVaultHedera} from "../src/TakarabakoVaultHedera.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// Stands in for the Hedera Token Service system contract at 0x167.
contract MockHts {
    int64 public code = 22;
    address public lastAccount;
    address public lastToken;
    uint256 public calls;

    function setCode(int64 c) external {
        code = c;
    }

    function associateToken(address account, address token) external returns (int64) {
        lastAccount = account;
        lastToken = token;
        calls++;
        return code;
    }
}

contract VaultHederaTest is Test {
    address internal constant HTS = address(0x167);
    address internal owner = address(0xA11CE);
    MockUSDC internal usdc;

    function setUp() public {
        usdc = new MockUSDC(owner);
        vm.etch(HTS, address(new MockHts()).code);
        MockHts(HTS).setCode(22);
    }

    function test_constructor_associates_itself_with_usdc() public {
        TakarabakoVaultHedera v = new TakarabakoVaultHedera(IERC20(address(usdc)), 420, owner);
        assertEq(MockHts(HTS).lastAccount(), address(v));
        assertEq(MockHts(HTS).lastToken(), address(usdc));
        assertEq(MockHts(HTS).calls(), 1);
    }

    function test_already_associated_is_fine() public {
        MockHts(HTS).setCode(194);
        new TakarabakoVaultHedera(IERC20(address(usdc)), 420, owner);
    }

    function test_other_response_codes_revert() public {
        MockHts(HTS).setCode(167); // INVALID_TOKEN_ID
        vm.expectRevert(abi.encodeWithSelector(TakarabakoVaultHedera.AssociationFailed.selector, int64(167)));
        new TakarabakoVaultHedera(IERC20(address(usdc)), 420, owner);
    }

    function test_associate_can_be_retried_by_anyone() public {
        TakarabakoVaultHedera v = new TakarabakoVaultHedera(IERC20(address(usdc)), 420, owner);
        vm.prank(address(0xBEEF));
        v.associate();
        assertEq(MockHts(HTS).calls(), 2);
    }

    function test_deposit_and_withdraw_work_as_usual() public {
        TakarabakoVaultHedera v = new TakarabakoVaultHedera(IERC20(address(usdc)), 420, owner);
        vm.startPrank(owner);
        usdc.mint(owner, 100e6);
        usdc.approve(address(v), type(uint256).max);
        v.depositFor(address(0xCAFE), 40e6);
        vm.stopPrank();
        assertApproxEqAbs(v.previewValue(address(0xCAFE)), 40e6, 1);
    }
}
