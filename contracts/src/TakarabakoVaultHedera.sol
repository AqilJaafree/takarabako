// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TakarabakoVault} from "./TakarabakoVault.sol";

/// @dev The one call of the Hedera Token Service system contract (HIP-206) this needs.
interface IHederaTokenService {
    function associateToken(address account, address token) external returns (int64 responseCode);
}

/// @notice The same vault, for Hedera. Circle's USDC there is a native Hedera Token Service
/// token (0.0.429274 on testnet) that a contract can only hold after it has been associated
/// with it, and only the contract itself can do that. So this vault associates itself with
/// the USDC token when it is created. Nothing else differs from `TakarabakoVault`.
contract TakarabakoVaultHedera is TakarabakoVault {
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));
    int64 internal constant SUCCESS = 22;
    int64 internal constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;

    error AssociationFailed(int64 responseCode);

    constructor(IERC20 usdc_, uint256 initialApyBps, address initialOwner)
        TakarabakoVault(usdc_, initialApyBps, initialOwner)
    {
        _associate();
    }

    /// @notice Retry the association (open to anyone: it can only associate this vault).
    function associate() external {
        _associate();
    }

    function _associate() internal {
        int64 rc = HTS.associateToken(address(this), address(usdc));
        if (rc != SUCCESS && rc != TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT) revert AssociationFailed(rc);
    }
}
