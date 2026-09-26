// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice tkCASH — a tokenized receipt for physical banknotes held in a
/// Takarabako kiosk. One token (6 decimals, like USDC) is a claim on one US
/// dollar of cash sitting in a specific kiosk's cash box.
///
/// The real-world asset is the cash in the box, so supply is tied to it:
/// the treasury (owner) mints only when a note is accepted (`recordCashIn`)
/// and burns when cash leaves the box (`redeem`), and each kiosk's on-chain
/// reserve moves with it — total supply always equals the sum of kiosk
/// reserves. An operator's physical count (`attestReserve`) is the
/// proof-of-reserve checkpoint; a count that doesn't match freezes that
/// kiosk's minting until a human resolves it.
///
/// Programmable controls on transfers between holders: both sides must be
/// allowlisted (identity-verified via Privy by the backend), a per-address
/// daily transfer limit, and a global pause. Mint and burn are the
/// treasury's own bookkeeping and bypass the transfer rules.
contract TakarabakoCashReceipt is ERC20, Ownable, Pausable {
    uint8 private constant DECIMALS = 6;

    struct Kiosk {
        bool active; // registered and in service
        bool frozen; // a reserve attestation didn't match — minting stopped
        uint256 reserve; // USD (6 decimals) of banknotes the chain says are in the box
        uint64 lastAuditAt;
    }

    mapping(bytes32 => Kiosk) public kiosks;
    uint256 public totalReserve;

    mapping(address => bool) public allowlist;
    uint256 public dailyTransferLimit; // 0 = no limit
    mapping(address => uint256) public spentToday;
    mapping(address => uint256) public spentDay; // the day index `spentToday` belongs to

    event KioskUpdated(bytes32 indexed kioskId, bool active);
    event CashIn(bytes32 indexed kioskId, address indexed user, uint256 amount, uint32 denomination, bytes3 currency);
    event CashOut(bytes32 indexed kioskId, address indexed user, uint256 amount);
    event ReserveAttested(bytes32 indexed kioskId, uint256 counted, uint256 onChain, int256 delta, bytes32 auditRef);
    event KioskFrozen(bytes32 indexed kioskId, int256 delta);
    event KioskUnfrozen(bytes32 indexed kioskId);
    event AllowlistUpdated(address indexed account, bool allowed);
    event DailyTransferLimitUpdated(uint256 limit);

    error KioskNotActive(bytes32 kioskId);
    error KioskIsFrozen(bytes32 kioskId);
    error InsufficientReserve(bytes32 kioskId, uint256 reserve, uint256 amount);
    error NotAllowlisted(address account);
    error DailyLimitExceeded(address account, uint256 spent, uint256 limit);

    constructor(address initialOwner) ERC20("Takarabako Cash Receipt", "tkCASH") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    // ---------- kiosks and cash ----------

    function setKiosk(bytes32 kioskId, bool active) external onlyOwner {
        kiosks[kioskId].active = active;
        emit KioskUpdated(kioskId, active);
    }

    /// @notice A note was accepted into `kioskId`'s cash box: the reserve
    /// grows and the same amount is minted to `user`.
    /// @param amount USD value, 6 decimals (MYR notes are converted off-chain)
    /// @param denomination face value of the note, in `currency`
    function recordCashIn(bytes32 kioskId, address user, uint256 amount, uint32 denomination, bytes3 currency)
        external
        onlyOwner
        whenNotPaused
    {
        Kiosk storage k = kiosks[kioskId];
        if (!k.active) revert KioskNotActive(kioskId);
        if (k.frozen) revert KioskIsFrozen(kioskId);
        k.reserve += amount;
        totalReserve += amount;
        _mint(user, amount);
        emit CashIn(kioskId, user, amount, denomination, currency);
    }

    /// @notice Cash left `kioskId`'s box for `user`: burn and shrink the
    /// reserve. Not blocked by pause or freeze — people can always cash out.
    function redeem(bytes32 kioskId, address user, uint256 amount) external onlyOwner {
        Kiosk storage k = kiosks[kioskId];
        if (k.reserve < amount) revert InsufficientReserve(kioskId, k.reserve, amount);
        k.reserve -= amount;
        totalReserve -= amount;
        _burn(user, amount);
        emit CashOut(kioskId, user, amount);
    }

    /// @notice An operator counted the box. A mismatch with the on-chain
    /// reserve freezes minting at that kiosk until `unfreezeKiosk`.
    function attestReserve(bytes32 kioskId, uint256 counted, bytes32 auditRef) external onlyOwner {
        Kiosk storage k = kiosks[kioskId];
        int256 delta = int256(counted) - int256(k.reserve);
        k.lastAuditAt = uint64(block.timestamp);
        emit ReserveAttested(kioskId, counted, k.reserve, delta, auditRef);
        if (delta != 0 && !k.frozen) {
            k.frozen = true;
            emit KioskFrozen(kioskId, delta);
        }
    }

    /// @notice A human resolved the mismatch (recount, correction).
    function unfreezeKiosk(bytes32 kioskId) external onlyOwner {
        kiosks[kioskId].frozen = false;
        emit KioskUnfrozen(kioskId);
    }

    // ---------- transfer controls ----------

    function setAllowlisted(address account, bool allowed) external onlyOwner {
        allowlist[account] = allowed;
        emit AllowlistUpdated(account, allowed);
    }

    function setDailyTransferLimit(uint256 limit) external onlyOwner {
        dailyTransferLimit = limit;
        emit DailyTransferLimitUpdated(limit);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Mint (from = 0) and burn (to = 0) are the treasury's bookkeeping
    /// and skip the rules; holder-to-holder transfers must pass all of them.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
            if (!allowlist[from]) revert NotAllowlisted(from);
            if (!allowlist[to]) revert NotAllowlisted(to);
            uint256 limit = dailyTransferLimit;
            if (limit != 0) {
                uint256 day = block.timestamp / 1 days;
                uint256 spent = spentDay[from] == day ? spentToday[from] : 0;
                spent += value;
                if (spent > limit) revert DailyLimitExceeded(from, spent, limit);
                spentToday[from] = spent;
                spentDay[from] = day;
            }
        }
        super._update(from, to, value);
    }
}
