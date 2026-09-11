// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice PRD §7.4 — ERC-4626-flavored vault over USDC. Not a strict IERC4626:
/// deposits are always fronted by the treasury (`depositFor`), and withdrawals
/// settle to an explicit recipient (the dev/treasury wallet in v1, per §6.6)
/// rather than back to the position owner.
interface ITakarabakoVault {
    /// @notice Treasury fronts `usdcAmount` from cash inserted into the box;
    /// shares are minted to `user`.
    function depositFor(address user, uint256 usdcAmount) external returns (uint256 shares);

    /// @notice Burns `shares` belonging to `owner` and sends principal + accrued
    /// yield in USDC to `recipient` (the dev/treasury wallet on withdraw).
    function withdrawTo(address owner, address recipient, uint256 shares)
        external
        returns (uint256 usdcAmount);

    function sharesOf(address user) external view returns (uint256);

    /// @notice Current USDC value of `user`'s shares, principal + yield included.
    function previewValue(address user) external view returns (uint256 usdcValue);

    function currentApyBps() external view returns (uint256);
}
