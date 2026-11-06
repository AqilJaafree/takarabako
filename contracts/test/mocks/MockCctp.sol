// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice A stand-in for Circle's CCTP V2 TokenMessenger + MessageTransmitter, for local
/// end-to-end runs of the bridge (backend/scripts/bridge-local-e2e.ts). It is placed at
/// Circle's testnet addresses with `anvil_setCode` on two local chains. `depositForBurn` takes
/// the USDC and emits a message; `receiveMessage` pays the recipient from this contract's own
/// USDC float and rejects a message it has seen ("Nonce already used", as the real one does).
/// There is no attestation check: the test supplies the attestation.
contract MockCctp {
    address public usdc;
    uint256 public nonce;
    mapping(bytes32 => bool) public used;

    event MessageSent(bytes message);

    function setUsdc(address token) external {
        usdc = token;
    }

    function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32, uint256, uint32)
        external
    {
        require(IERC20(burnToken).transferFrom(msg.sender, address(this), amount), "transfer failed");
        emit MessageSent(abi.encode(mintRecipient, amount, destinationDomain, ++nonce));
    }

    function receiveMessage(bytes calldata message, bytes calldata) external returns (bool) {
        bytes32 h = keccak256(message);
        require(!used[h], "Nonce already used");
        used[h] = true;
        (bytes32 recipient, uint256 amount,,) = abi.decode(message, (bytes32, uint256, uint32, uint256));
        require(IERC20(usdc).transfer(address(uint160(uint256(recipient))), amount), "mint failed");
        return true;
    }
}
