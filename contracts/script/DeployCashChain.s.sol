// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TakarabakoVault} from "../src/TakarabakoVault.sol";
import {TakarabakoVaultHedera} from "../src/TakarabakoVaultHedera.sol";
import {TakarabakoCashReceipt} from "../src/TakarabakoCashReceipt.sol";

/// @notice Deploys one cash chain's pair of contracts, the vault and tkCASH, against
/// real USDC (no mocks), owned by the deployer (the backend's treasury signer).
/// Used for Arc Testnet and for the Sepolia vault that CCTP can bridge.
///
///   USDC_ADDRESS      default Arc's USDC (0x3600…0000, 6 decimals as an ERC-20);
///                     for Ethereum Sepolia use Circle's 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
///   KIOSK_ID          kiosk to register in tkCASH (default tokyo-01)
///   DAILY_LIMIT_USD   per-address daily tkCASH transfer limit, same figure as the backend (default 1000)
///   APY_BPS           the vault's advertised APY (default 420 = 4.20%)
///   SKIP_TKCASH=1     deploy only the vault (when tkCASH already exists on this chain)
///   HEDERA=1          deploy the Hedera vault, which associates itself with the USDC token
///                     (Hedera Token Service) when created
///
/// Arc Testnet (gas is paid in USDC, and sends need maxFeePerGas >= 20 gwei):
///   forge script script/DeployCashChain.s.sol --rpc-url https://rpc.testnet.arc.io \
///     --broadcast --private-key $TREASURY_PRIVATE_KEY --with-gas-price 25gwei --legacy
///
/// Hedera Testnet (chain 296; USDC is HTS token 0.0.429274, EVM address 0x…068cda). Hedera's
/// system contracts don't exist in forge's local simulation, so skip it:
///   HEDERA=1 USDC_ADDRESS=0x0000000000000000000000000000000000068cda \
///   forge script script/DeployCashChain.s.sol --rpc-url https://testnet.hashio.io/api \
///     --broadcast --private-key $TREASURY_PRIVATE_KEY --skip-simulation --legacy
contract DeployCashChain is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        address usdc = vm.envOr("USDC_ADDRESS", ARC_USDC);
        string memory kioskId = vm.envOr("KIOSK_ID", string("tokyo-01"));
        uint256 dailyLimitUsd = vm.envOr("DAILY_LIMIT_USD", uint256(1000));
        uint256 apyBps = vm.envOr("APY_BPS", uint256(420));
        bool skipTk = vm.envOr("SKIP_TKCASH", false);

        require(usdc.code.length > 0, "no contract at USDC_ADDRESS on this chain");

        vm.startBroadcast();
        address deployer = msg.sender;

        TakarabakoVault vault = vm.envOr("HEDERA", false)
            ? new TakarabakoVaultHedera(IERC20(usdc), apyBps, deployer)
            : new TakarabakoVault(IERC20(usdc), apyBps, deployer);
        // The vault pulls USDC from the treasury on depositFor / fundYieldReserve.
        IERC20(usdc).approve(address(vault), type(uint256).max);

        TakarabakoCashReceipt tk;
        if (!skipTk) {
            tk = new TakarabakoCashReceipt(deployer);
            tk.setKiosk(bytes32(bytes(kioskId)), true);
            tk.setDailyTransferLimit(dailyLimitUsd * 1e6);
        }
        vm.stopBroadcast();

        console.log("USDC:                 ", usdc);
        console.log("TakarabakoVault:      ", address(vault));
        if (!skipTk) {
            console.log("TakarabakoCashReceipt:", address(tk));
            console.log("Kiosk registered:     ", kioskId);
        }
        console.log("Owner / treasury:     ", deployer);
    }
}
