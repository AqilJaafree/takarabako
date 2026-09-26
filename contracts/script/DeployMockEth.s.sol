// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockRiskToken} from "../src/mocks/MockRiskToken.sol";

/// @notice Deploys mETH, a mintable stand-in for ETH used by the 1inch Aqua
/// yield strategies (mETH/mUSDC). Real Sepolia ETH is too scarce to seed
/// one-sided ETH ranges; mETH is priced off a live ETH/USD feed off-chain.
/// Mints a float to the treasury (the Aqua maker).
/// Run: `forge script script/DeployMockEth.s.sol --rpc-url <rpc> --broadcast --private-key <pk>`
contract DeployMockEth is Script {
    function run() external {
        vm.startBroadcast();
        MockRiskToken meth = new MockRiskToken("Mock Ether", "mETH", 18, msg.sender);
        meth.mint(msg.sender, 1_000_000 ether);
        vm.stopBroadcast();
        console.log("mETH:", address(meth));
    }
}
