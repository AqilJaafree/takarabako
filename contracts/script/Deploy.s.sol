// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockJPYC} from "../src/mocks/MockJPYC.sol";
import {MockRiskToken} from "../src/mocks/MockRiskToken.sol";
import {TakarabakoVault} from "../src/TakarabakoVault.sol";

/// @notice PRD Phase 0 (§12): deploy MockJPYC + the medium/high risk-tier
/// mock tokens + the vault to a testnet, all owned by the deployer (stands
/// in for the backend's treasury signer during local/testnet development).
/// Run: `forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <pk>`
contract Deploy is Script {
    // 4.20% mock APY, matching the PRD's demo script (§14).
    uint256 constant INITIAL_APY_BPS = 420;

    function run() external {
        vm.startBroadcast();
        address deployer = msg.sender;

        MockJPYC jpyc = new MockJPYC(deployer);
        MockRiskToken projectToken = new MockRiskToken("Mock AAVE", "mAAVE", 18, deployer);
        MockRiskToken memeToken = new MockRiskToken("Mock DOGE", "mDOGE", 18, deployer);

        TakarabakoVault vault = new TakarabakoVault(jpyc, INITIAL_APY_BPS, deployer);

        // Seed the treasury with a faucet balance and pre-approve the vault
        // so `depositFor` / `fundYieldReserve` can pull from it directly.
        jpyc.mint(deployer, 100_000_000 ether);
        jpyc.approve(address(vault), type(uint256).max);

        vm.stopBroadcast();

        console.log("MockJPYC:        ", address(jpyc));
        console.log("MockRiskToken(AAVE):", address(projectToken));
        console.log("MockRiskToken(DOGE):", address(memeToken));
        console.log("TakarabakoVault:  ", address(vault));
    }
}
