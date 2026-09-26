// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TakarabakoCashReceipt} from "../src/TakarabakoCashReceipt.sol";

/// @notice Deploys tkCASH on its own, so the already-verified vault and
/// mocks (Deploy.s.sol) aren't redeployed. Owned by the deployer — the
/// backend's treasury signer — and registers the first kiosk.
/// Run: `KIOSK_ID=tokyo-01 forge script script/DeployCashReceipt.s.sol --rpc-url <rpc> --broadcast --private-key <pk>`
contract DeployCashReceipt is Script {
    function run() external {
        string memory kioskId = vm.envOr("KIOSK_ID", string("tokyo-01"));

        vm.startBroadcast();
        TakarabakoCashReceipt tk = new TakarabakoCashReceipt(msg.sender);
        tk.setKiosk(bytes32(bytes(kioskId)), true);
        vm.stopBroadcast();

        console.log("TakarabakoCashReceipt:", address(tk));
        console.log("Kiosk registered:     ", kioskId);
    }
}
