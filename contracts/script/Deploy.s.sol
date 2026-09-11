// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockRiskToken} from "../src/mocks/MockRiskToken.sol";
import {TakarabakoVault} from "../src/TakarabakoVault.sol";

/// @notice PRD Phase 0 (§12): deploy MockUSDC + the medium/high risk-tier
/// mock tokens + the vault to a testnet, all owned by the deployer (stands
/// in for the backend's treasury signer during local/testnet development).
/// Run: `forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <pk>`
contract Deploy is Script {
    // 4.20% mock APY, matching the PRD's demo script (§14).
    uint256 constant INITIAL_APY_BPS = 420;

    function run() external {
        vm.startBroadcast();
        address deployer = msg.sender;

        MockUSDC usdc = new MockUSDC(deployer);
        MockRiskToken projectToken = new MockRiskToken("Mock AAVE", "mAAVE", 18, deployer);
        MockRiskToken memeToken = new MockRiskToken("Mock DOGE", "mDOGE", 18, deployer);

        TakarabakoVault vault = new TakarabakoVault(usdc, INITIAL_APY_BPS, deployer);

        // Seed the treasury with a faucet balance and pre-approve the vault
        // so `depositFor` / `fundYieldReserve` can pull from it directly.
        // USDC uses 6 decimals, not 18 — see MockUSDC.sol.
        usdc.mint(deployer, 100_000_000e6);
        usdc.approve(address(vault), type(uint256).max);

        vm.stopBroadcast();

        console.log("MockUSDC:            ", address(usdc));
        console.log("MockRiskToken(AAVE):", address(projectToken));
        console.log("MockRiskToken(DOGE):", address(memeToken));
        console.log("TakarabakoVault:     ", address(vault));
    }
}
