// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet stand-in for JPYC (Japan's FSA-licensed yen stablecoin).
/// @dev Mainnet swaps this address for the real JPYC ERC-20 — see PRD §7.5.
contract MockJPYC is ERC20, Ownable {
    uint8 private constant DECIMALS = 18;

    constructor(address initialOwner) ERC20("Mock JPYC", "mJPYC") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Treasury-only faucet mint, used to fund the box's float on testnet.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
