// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet stand-in for USDC.
/// @dev Mainnet swaps this address for the real USDC ERC-20. Matches real
/// USDC's 6 decimals rather than the usual 18 — that mismatch is a common
/// source of DeFi accounting bugs, so the mock should behave like the real
/// thing here.
contract MockUSDC is ERC20, Ownable {
    uint8 private constant DECIMALS = 6;

    constructor(address initialOwner) ERC20("Mock USDC", "mUSDC") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Treasury-only faucet mint, used to fund the box's float on testnet.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
