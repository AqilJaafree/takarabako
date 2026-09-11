// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ITakarabakoVault} from "./interfaces/ITakarabakoVault.sol";

/// @notice PRD §7.4 + §7.6 baseline yield strategy: a mock vault whose
/// share/asset exchange rate ticks up over time at a fixed APR, so the demo
/// shows a visibly rising balance without depending on a live Uniswap
/// integration. `owner` is the backend's treasury signer (PRD §10) — the
/// only address allowed to move shares, matching "treasury key lives only
/// in the backend, never on the Pi."
contract TakarabakoVault is ITakarabakoVault, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant RAY = 1e18;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant SECONDS_PER_YEAR = 365 days;

    IERC20 public immutable jpyc;

    uint256 public exchangeRate = RAY; // JPYC per share, RAY-scaled
    uint256 public apyBps; // e.g. 420 = 4.20%
    uint256 public lastAccrualTs;

    mapping(address => uint256) private _shares;
    uint256 public totalShares;

    event Deposited(address indexed user, uint256 jpycAmount, uint256 shares);
    event Withdrawn(address indexed owner, address indexed recipient, uint256 shares, uint256 jpycAmount);
    event ApyUpdated(uint256 newApyBps);
    event YieldReserveFunded(uint256 amount);

    constructor(IERC20 jpyc_, uint256 initialApyBps, address initialOwner) Ownable(initialOwner) {
        jpyc = jpyc_;
        apyBps = initialApyBps;
        lastAccrualTs = block.timestamp;
    }

    /// @notice Treasury fronts `jpycAmount` (already pulled into this tx via
    /// `transferFrom`, so the treasury must have approved the vault once at
    /// setup); shares are minted to `user`.
    function depositFor(address user, uint256 jpycAmount) external onlyOwner returns (uint256 shares) {
        require(jpycAmount > 0, "zero amount");
        _accrue();

        jpyc.safeTransferFrom(msg.sender, address(this), jpycAmount);

        shares = (jpycAmount * RAY) / exchangeRate;
        _shares[user] += shares;
        totalShares += shares;

        emit Deposited(user, jpycAmount, shares);
    }

    /// @notice Burns `shares` of `owner` and sends principal + accrued yield
    /// to `recipient` — the dev/treasury wallet in the v1 withdraw flow
    /// (PRD §6.6); the 2% cash-redemption fee is computed by the backend on
    /// top of `jpycAmount`, not inside the vault.
    function withdrawTo(address owner_, address recipient, uint256 shares)
        external
        onlyOwner
        returns (uint256 jpycAmount)
    {
        require(shares > 0 && shares <= _shares[owner_], "bad shares");
        _accrue();

        jpycAmount = (shares * exchangeRate) / RAY;
        _shares[owner_] -= shares;
        totalShares -= shares;

        jpyc.safeTransfer(recipient, jpycAmount);

        emit Withdrawn(owner_, recipient, shares, jpycAmount);
    }

    /// @notice Treasury tops up the JPYC actually held by the vault so it can
    /// pay out the yield implied by the rising exchange rate. Mirrors PRD
    /// §7.6: "topped up from a rewards wallet."
    function fundYieldReserve(uint256 amount) external onlyOwner {
        jpyc.safeTransferFrom(msg.sender, address(this), amount);
        emit YieldReserveFunded(amount);
    }

    function setApyBps(uint256 newApyBps) external onlyOwner {
        _accrue();
        apyBps = newApyBps;
        emit ApyUpdated(newApyBps);
    }

    function sharesOf(address user) external view returns (uint256) {
        return _shares[user];
    }

    function previewValue(address user) external view returns (uint256 jpycValue) {
        return (_shares[user] * _projectedExchangeRate()) / RAY;
    }

    function currentApyBps() external view returns (uint256) {
        return apyBps;
    }

    function _accrue() internal {
        exchangeRate = _projectedExchangeRate();
        lastAccrualTs = block.timestamp;
    }

    function _projectedExchangeRate() internal view returns (uint256) {
        uint256 elapsed = block.timestamp - lastAccrualTs;
        if (elapsed == 0 || apyBps == 0) return exchangeRate;
        uint256 accrued = (exchangeRate * apyBps * elapsed) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
        return exchangeRate + accrued;
    }
}
