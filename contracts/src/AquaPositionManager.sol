// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The slice of 1inch Aqua this contract uses. Aqua keeps *virtual* balances per
/// (maker, app, strategy hash): the tokens stay in the maker's address and are pulled when a
/// swap fills, so the maker must hold them and have approved Aqua.
interface IAqua {
    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external
        returns (bytes32 strategyHash);

    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;

    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount);
}

/// @title AquaPositionManager
/// @notice Opens a whole liquidity position on 1inch Aqua in ONE transaction. A position is
/// several strategies (a Curve is five); Aqua's `ship` takes one strategy per call and treats
/// the caller as the maker, so a user's wallet needs one transaction per strategy. This
/// contract is the maker instead: a user approves it once per token, then `open` pulls the
/// tokens and ships every strategy at once, and `close` docks them all and sends back whatever
/// the position holds.
///
/// @dev Custody and trust, stated plainly:
///  - The tokens of every open position sit in THIS contract, commingled. What keeps positions
///    apart is accounting: a position can only ever be paid out what Aqua's own virtual balances
///    say its strategies hold, and Aqua cannot pay a strategy out beyond those balances.
///  - There is no owner, no admin function, no upgrade, no pause, no rescue and no fee. Nobody
///    can move anyone's tokens except through `close` by the position's owner. The price of that
///    is that nothing can be fixed after deployment: a bug means deploying a new manager.
///  - Only the two tokens given at construction can be used, and only through one Aqua app
///    (the SwapVM router). A new router version means a new manager.
///  - The contract approves Aqua for the maximum of both tokens once. Aqua's `pull` is what pays
///    traders out of the pool, bounded by each strategy's virtual balance; a flaw in Aqua itself
///    would put the whole pool at risk, which is the cost of pooling.
///  - The strategy bytes are not inspected. A strategy whose order names another maker is inert
///    (swaps look up the maker named in the order), and its owner can still `close` it and get
///    back what they put in.
contract AquaPositionManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A position: who owns it and the Aqua strategies it is made of.
    struct Position {
        address owner;
        bool closed;
        bytes32[] hashes;
    }

    IAqua public immutable aqua;
    /// @notice The Aqua app the strategies run on (the SwapVM router).
    address public immutable app;
    IERC20 public immutable weth;
    IERC20 public immutable usdc;

    /// @notice More strategies than this in one position is refused (a bound on the gas of `close`).
    uint256 public constant MAX_STRATEGIES = 12;

    uint256 public nextPositionId;
    mapping(uint256 id => Position) private _positions;

    event Opened(uint256 indexed id, address indexed owner, bytes32[] hashes, uint256 weth, uint256 usdc);
    event Closed(uint256 indexed id, address indexed owner, uint256 weth, uint256 usdc);

    error BadInput();
    error NotOwner();
    error AlreadyClosed();
    error ShortTransfer();

    constructor(IAqua aqua_, address app_, IERC20 weth_, IERC20 usdc_) {
        aqua = aqua_;
        app = app_;
        weth = weth_;
        usdc = usdc_;
        // Aqua pays traders out of this contract's balance with transferFrom.
        weth_.forceApprove(address(aqua_), type(uint256).max);
        usdc_.forceApprove(address(aqua_), type(uint256).max);
    }

    /// @notice Opens a position: pulls the tokens from the caller and ships every strategy.
    /// @param strategies The encoded SwapVM orders, each built with this contract as the maker.
    /// @param wethAmounts Per strategy, the WETH its virtual balance starts with.
    /// @param usdcAmounts Per strategy, the USDC its virtual balance starts with.
    /// @dev The caller must have approved this contract for the totals. Only what the strategies
    /// start with is pulled, so every virtual balance is backed by a real deposit.
    function open(bytes[] calldata strategies, uint256[] calldata wethAmounts, uint256[] calldata usdcAmounts)
        external
        nonReentrant
        returns (uint256 id)
    {
        uint256 n = strategies.length;
        if (n == 0 || n > MAX_STRATEGIES || wethAmounts.length != n || usdcAmounts.length != n) revert BadInput();

        uint256 totalWeth;
        uint256 totalUsdc;
        for (uint256 i; i < n; ++i) {
            totalWeth += wethAmounts[i];
            totalUsdc += usdcAmounts[i];
        }
        if (totalWeth == 0 && totalUsdc == 0) revert BadInput();

        _pull(weth, totalWeth);
        _pull(usdc, totalUsdc);

        id = ++nextPositionId;
        Position storage p = _positions[id];
        p.owner = msg.sender;

        for (uint256 i; i < n; ++i) {
            p.hashes.push(_ship(strategies[i], wethAmounts[i], usdcAmounts[i]));
        }
        emit Opened(id, msg.sender, p.hashes, totalWeth, totalUsdc);
    }

    function _ship(bytes calldata strategy, uint256 wethAmount, uint256 usdcAmount) private returns (bytes32) {
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = wethAmount;
        amounts[1] = usdcAmount;
        return aqua.ship(app, strategy, tokens, amounts);
    }

    /// @notice Closes a position: docks every strategy and sends the owner what they held.
    /// @dev What each strategy holds is read from Aqua just before it is docked, so the owner gets
    /// their deposit plus what trades added (fees and the other token), and nothing of anyone else's.
    function close(uint256 id) external nonReentrant {
        Position storage p = _positions[id];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.closed) revert AlreadyClosed();
        p.closed = true; // before anything moves

        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);

        uint256 w;
        uint256 u;
        uint256 n = p.hashes.length;
        for (uint256 i; i < n; ++i) {
            bytes32 h = p.hashes[i];
            (uint248 bw,) = aqua.rawBalances(address(this), app, h, address(weth));
            (uint248 bu,) = aqua.rawBalances(address(this), app, h, address(usdc));
            w += bw;
            u += bu;
            aqua.dock(app, h, tokens);
        }
        if (w > 0) weth.safeTransfer(msg.sender, w);
        if (u > 0) usdc.safeTransfer(msg.sender, u);
        emit Closed(id, msg.sender, w, u);
    }

    /// @notice A position's owner, whether it is closed, and its strategy hashes.
    function positionOf(uint256 id) external view returns (address owner, bool closed, bytes32[] memory hashes) {
        Position storage p = _positions[id];
        return (p.owner, p.closed, p.hashes);
    }

    /// @dev Pulls `amount` from the caller and checks all of it arrived (a token that took a fee
    /// on transfer would leave virtual balances unbacked).
    function _pull(IERC20 token, uint256 amount) private {
        if (amount == 0) return;
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - before != amount) revert ShortTransfer();
    }
}
