// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AquaPositionManager, IAqua} from "../src/AquaPositionManager.sol";
import {Fixtures} from "./Fixtures.sol";

/// Stand-in for Arc's native-transfer precompile (0x1800…0000), which Arc's USDC calls to move
/// balance (USDC is the chain's native coin; 18 decimals here). Foundry's EVM doesn't have it.
contract NativeTransferMock {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function transfer(address from, address to, uint256 amount) external returns (bool) {
        vm.deal(from, from.balance - amount);
        vm.deal(to, to.balance + amount);
        return true;
    }
}

/// An attacker's maker hook. The router calls preTransferOut on a strategy's hook target in the
/// middle of every swap, so this runs inside a trade against the attacker's strategy and tries
/// every way it can think of to take other users' tokens. Each attempt's success is recorded.
contract MaliciousHook {
    address mgr;
    address aqua;
    address router;
    address usdc;
    address attacker;
    bytes32 victimHash;
    uint256 victimId;

    bool public ran;
    bool public transferFromWorked;
    bool public aquaPullWorked;
    bool public closeVictimWorked;
    bool public dockVictimWorked;

    function configure(address mgr_, address aqua_, address router_, address usdc_, address attacker_, bytes32 hash_, uint256 id_) external {
        (mgr, aqua, router, usdc, attacker, victimHash, victimId) = (mgr_, aqua_, router_, usdc_, attacker_, hash_, id_);
    }

    bytes4 public selector;
    uint256 public size;

    // A fallback, not preTransferOut(...): this records what the router really sends.
    fallback() external {
        ran = true;
        selector = bytes4(msg.data);
        size = msg.data.length;
        // 1. spend the manager's USDC directly (needs an allowance to this hook)
        (transferFromWorked,) = usdc.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", mgr, attacker, 20e6));
        // 2. ask Aqua to pay a victim's strategy out (Aqua only honours the registered app)
        (aquaPullWorked,) = aqua.call(abi.encodeWithSignature("pull(address,bytes32,address,uint256,address)", mgr, victimHash, usdc, 1e6, attacker));
        // 3. close the victim's position
        (closeVictimWorked,) = mgr.call(abi.encodeWithSignature("close(uint256)", victimId));
        // 4. dock the victim's strategy through Aqua
        address[] memory t = new address[](2);
        (dockVictimWorked,) = aqua.call(abi.encodeWithSignature("dock(address,bytes32,address[])", router, victimHash, t));
    }
}

/// Fork tests against the real Aqua and SwapVM router on Arc mainnet. Nothing is deployed
/// there: the manager is placed at the address the fixtures name as the strategies' maker.
///   ARC_RPC_URL=https://rpc.mainnet.arc.io forge test --match-contract AquaPositionManagerTest
contract AquaPositionManagerTest is Test {
    IAqua constant AQUA = IAqua(Fixtures.AQUA);
    address constant ROUTER = Fixtures.ROUTER;
    IERC20 constant WETH = IERC20(Fixtures.WETH);
    IERC20 constant USDC = IERC20(Fixtures.USDC);

    AquaPositionManager mgr;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address trader = makeAddr("trader");

    function setUp() public {
        vm.createSelectFork(vm.envOr("FORK_RPC_URL", Fixtures.RPC));
        // Arc's USDC and WETH ask a blocklist precompile on every transfer; Foundry's EVM doesn't
        // have it. Stand in for it with code that answers "not blocked" (returns 32 zero bytes).
        if (block.chainid == 5042) {
            vm.etch(0x1800000000000000000000000000000000000001, hex"5f5f5260205ff3");
            vm.etch(0x1800000000000000000000000000000000000000, address(new NativeTransferMock()).code);
            vm.allowCheatcodes(0x1800000000000000000000000000000000000000);
        }
        deployCodeTo("src/AquaPositionManager.sol:AquaPositionManager", abi.encode(AQUA, ROUTER, WETH, USDC), Fixtures.MANAGER);
        mgr = AquaPositionManager(Fixtures.MANAGER);
        // deployCodeTo keeps the code, not the constructor's storage: redo the approvals.
        vm.startPrank(address(mgr));
        WETH.approve(address(AQUA), type(uint256).max);
        USDC.approve(address(AQUA), type(uint256).max);
        vm.stopPrank();

        for (uint256 i; i < 3; ++i) {
            address u = i == 0 ? alice : i == 1 ? bob : trader;
            _give(address(WETH), u, 10 ether);
            _give(address(USDC), u, 100_000e6);
        }
        vm.startPrank(alice);
        WETH.approve(address(mgr), type(uint256).max);
        USDC.approve(address(mgr), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(bob);
        WETH.approve(address(mgr), type(uint256).max);
        USDC.approve(address(mgr), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(trader);
        WETH.approve(ROUTER, type(uint256).max);
        USDC.approve(ROUTER, type(uint256).max);
        vm.stopPrank();
    }

    /// Sets a token balance by writing the balances mapping directly. forge-std's `deal` can't
    /// find the slot for these tokens (WETH keeps it in ERC-7201 namespaced storage), so try the
    /// namespaced base and then the plain low slots, keeping whichever makes balanceOf agree.
    function _give(address token, address to, uint256 amount) internal {
        if (token == address(USDC) && block.chainid == 5042) {
            // Arc's USDC is the chain's native coin seen through an ERC-20 (18 decimals native, 6 here).
            vm.deal(to, amount * 1e12);
            assertEq(USDC.balanceOf(to), amount);
            return;
        }
        bytes32[] memory bases = new bytes32[](34);
        bases[0] = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00;
        for (uint256 i = 1; i < 34; ++i) bases[i] = bytes32(i - 1);
        for (uint256 i; i < bases.length; ++i) {
            bytes32 slot = keccak256(abi.encode(to, bases[i]));
            bytes32 old = vm.load(token, slot);
            vm.store(token, slot, bytes32(amount));
            if (IERC20(token).balanceOf(to) == amount) return;
            vm.store(token, slot, old);
        }
        revert(string.concat("could not set balance of ", vm.toString(token)));
    }

    // ---- helpers -------------------------------------------------------------------------

    function _slice(bytes[] memory s, uint256 from, uint256 to) internal pure returns (bytes[] memory out) {
        out = new bytes[](to - from);
        for (uint256 i = from; i < to; ++i) out[i - from] = s[i];
    }

    function _slice(uint256[] memory s, uint256 from, uint256 to) internal pure returns (uint256[] memory out) {
        out = new uint256[](to - from);
        for (uint256 i = from; i < to; ++i) out[i - from] = s[i];
    }

    function _sum(uint256[] memory a) internal pure returns (uint256 t) {
        for (uint256 i; i < a.length; ++i) t += a[i];
    }

    function _open(address who) internal returns (uint256 id) {
        vm.prank(who);
        id = mgr.open(Fixtures.strategies(), Fixtures.wethAmounts(), Fixtures.usdcAmounts());
    }

    function _virtual(bytes32 h) internal view returns (uint256 w, uint256 u) {
        (uint248 bw,) = AQUA.rawBalances(address(mgr), ROUTER, h, address(WETH));
        (uint248 bu,) = AQUA.rawBalances(address(mgr), ROUTER, h, address(USDC));
        return (bw, bu);
    }

    function _swap(bytes memory data) internal {
        vm.prank(trader);
        (bool ok,) = ROUTER.call(data);
        assertTrue(ok, "swap failed");
    }

    /// The manager must always physically hold at least what every open strategy says it owns.
    function _assertBacked(uint256[] memory ids) internal view {
        uint256 w;
        uint256 u;
        for (uint256 k; k < ids.length; ++k) {
            (, bool closed, bytes32[] memory hs) = mgr.positionOf(ids[k]);
            if (closed) continue;
            for (uint256 i; i < hs.length; ++i) {
                (uint256 sw, uint256 su) = _virtual(hs[i]);
                w += sw;
                u += su;
            }
        }
        assertGe(WETH.balanceOf(address(mgr)), w, "WETH under-backed");
        assertGe(USDC.balanceOf(address(mgr)), u, "USDC under-backed");
    }

    // ---- open ----------------------------------------------------------------------------

    function test_open_ships_every_strategy_in_one_call() public {
        uint256 wBefore = WETH.balanceOf(alice);
        uint256 uBefore = USDC.balanceOf(alice);
        uint256 id = _open(alice);

        assertEq(id, 1);
        (address owner, bool closed, bytes32[] memory hs) = mgr.positionOf(id);
        assertEq(owner, alice);
        assertFalse(closed);
        assertEq(hs.length, Fixtures.COUNT);

        uint256[] memory w = Fixtures.wethAmounts();
        uint256[] memory u = Fixtures.usdcAmounts();
        for (uint256 i; i < hs.length; ++i) {
            (uint256 vw, uint256 vu) = _virtual(hs[i]);
            assertEq(vw, w[i]);
            assertEq(vu, u[i]);
        }
        assertEq(wBefore - WETH.balanceOf(alice), _sum(w));
        assertEq(uBefore - USDC.balanceOf(alice), _sum(u));
        assertEq(WETH.balanceOf(address(mgr)), _sum(w));
        assertEq(USDC.balanceOf(address(mgr)), _sum(u));
    }

    function test_open_refuses_bad_input() public {
        bytes[] memory s = Fixtures.strategies();
        uint256[] memory w = Fixtures.wethAmounts();
        uint256[] memory u = Fixtures.usdcAmounts();
        vm.startPrank(alice);

        vm.expectRevert(AquaPositionManager.BadInput.selector);
        mgr.open(new bytes[](0), new uint256[](0), new uint256[](0));

        vm.expectRevert(AquaPositionManager.BadInput.selector);
        mgr.open(s, _slice(w, 0, 3), u); // length mismatch

        vm.expectRevert(AquaPositionManager.BadInput.selector);
        mgr.open(s, w, _slice(u, 0, 3));

        vm.expectRevert(AquaPositionManager.BadInput.selector);
        mgr.open(s, new uint256[](5), new uint256[](5)); // nothing deposited

        bytes[] memory many = new bytes[](13);
        vm.expectRevert(AquaPositionManager.BadInput.selector);
        mgr.open(many, new uint256[](13), new uint256[](13));
        vm.stopPrank();
    }

    function test_open_without_allowance_reverts_and_takes_nothing() public {
        address carol = makeAddr("carol");
        _give(address(WETH), carol, 10 ether);
        _give(address(USDC), carol, 100_000e6);
        vm.prank(carol);
        vm.expectRevert();
        mgr.open(Fixtures.strategies(), Fixtures.wethAmounts(), Fixtures.usdcAmounts());
        assertEq(WETH.balanceOf(carol), 10 ether);
        assertEq(USDC.balanceOf(address(mgr)), 0);
    }

    // ---- close ---------------------------------------------------------------------------

    function test_close_without_trades_returns_the_deposit() public {
        uint256 wBefore = WETH.balanceOf(alice);
        uint256 uBefore = USDC.balanceOf(alice);
        uint256 id = _open(alice);
        vm.prank(alice);
        mgr.close(id);

        assertEq(WETH.balanceOf(alice), wBefore);
        assertEq(USDC.balanceOf(alice), uBefore);
        assertEq(WETH.balanceOf(address(mgr)), 0);
        assertEq(USDC.balanceOf(address(mgr)), 0);
        (, bool closed,) = mgr.positionOf(id);
        assertTrue(closed);
    }

    function _virtualTotal(uint256 id) internal view returns (uint256 w, uint256 u) {
        (, , bytes32[] memory hs) = mgr.positionOf(id);
        for (uint256 i; i < hs.length; ++i) {
            (uint256 vw, uint256 vu) = _virtual(hs[i]);
            w += vw;
            u += vu;
        }
    }

    function test_trades_move_the_position_and_close_pays_out_the_new_balances() public {
        uint256 id = _open(alice);
        (uint256 w0, uint256 u0) = _virtualTotal(id);

        _swap(Fixtures.swapUsdcForWeth());
        (uint256 w1, uint256 u1) = _virtualTotal(id);
        assertLt(w1, w0, "WETH should leave the position");
        assertGt(u1, u0, "USDC should enter the position");

        _swap(Fixtures.swapWethForUsdc());

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        _assertBacked(ids);

        // What close returns is exactly the sum of the virtual balances Aqua holds for it.
        (uint256 expW, uint256 expU) = _virtualTotal(id);
        uint256 wBefore = WETH.balanceOf(alice);
        uint256 uBefore = USDC.balanceOf(alice);
        vm.prank(alice);
        mgr.close(id);
        assertEq(WETH.balanceOf(alice) - wBefore, expW);
        assertEq(USDC.balanceOf(alice) - uBefore, expU);
        assertEq(WETH.balanceOf(address(mgr)), 0, "nothing should be left behind");
        assertEq(USDC.balanceOf(address(mgr)), 0, "nothing should be left behind");
    }

    function test_only_the_owner_can_close() public {
        uint256 id = _open(alice);
        vm.prank(bob);
        vm.expectRevert(AquaPositionManager.NotOwner.selector);
        mgr.close(id);
        vm.prank(address(this));
        vm.expectRevert(AquaPositionManager.NotOwner.selector);
        mgr.close(id);
        vm.expectRevert(AquaPositionManager.NotOwner.selector);
        mgr.close(999); // a position that doesn't exist has no owner
    }

    function test_a_position_closes_once() public {
        uint256 id = _open(alice);
        vm.startPrank(alice);
        mgr.close(id);
        vm.expectRevert(AquaPositionManager.AlreadyClosed.selector);
        mgr.close(id);
        vm.stopPrank();
    }

    // ---- two users -----------------------------------------------------------------------

    function test_positions_of_different_users_stay_apart() public {
        bytes[] memory s = Fixtures.strategies();
        uint256[] memory w = Fixtures.wethAmounts();
        uint256[] memory u = Fixtures.usdcAmounts();

        vm.prank(alice);
        uint256 a = mgr.open(_slice(s, 0, 2), _slice(w, 0, 2), _slice(u, 0, 2));
        vm.prank(bob);
        uint256 b = mgr.open(_slice(s, 2, 5), _slice(w, 2, 5), _slice(u, 2, 5));
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        _assertBacked(ids);

        // A trade against strategy 2 (Bob's) must not change what Alice is owed.
        _swap(Fixtures.swapUsdcForWeth());
        _assertBacked(ids);

        uint256 aW = WETH.balanceOf(alice);
        uint256 aU = USDC.balanceOf(alice);
        vm.prank(alice);
        mgr.close(a);
        assertEq(WETH.balanceOf(alice) - aW, w[0] + w[1], "Alice gets exactly her deposit");
        assertEq(USDC.balanceOf(alice) - aU, u[0] + u[1], "Alice gets exactly her deposit");

        // Bob can still close and gets his strategies, including what the trade changed.
        _assertBacked(ids);
        (, , bytes32[] memory hs) = mgr.positionOf(b);
        uint256 expW;
        uint256 expU;
        for (uint256 i; i < hs.length; ++i) {
            (uint256 vw, uint256 vu) = _virtual(hs[i]);
            expW += vw;
            expU += vu;
        }
        uint256 bW = WETH.balanceOf(bob);
        uint256 bU = USDC.balanceOf(bob);
        vm.prank(bob);
        mgr.close(b);
        assertEq(WETH.balanceOf(bob) - bW, expW);
        assertEq(USDC.balanceOf(bob) - bU, expU);
        assertEq(WETH.balanceOf(address(mgr)), 0);
        assertEq(USDC.balanceOf(address(mgr)), 0);
    }

    function test_a_strategy_cannot_be_opened_twice() public {
        _open(alice);
        vm.prank(bob);
        vm.expectRevert(); // Aqua refuses a hash that is already shipped
        mgr.open(Fixtures.strategies(), Fixtures.wethAmounts(), Fixtures.usdcAmounts());
    }

    // ---- fuzz ----------------------------------------------------------------------------

    /// Whatever amounts go in, closing with no trades returns exactly that and leaves nothing.
    function testFuzz_roundtrip_returns_exactly_the_deposit(uint96 wScale, uint96 uScale) public {
        wScale = uint96(bound(wScale, 0, 700_000));
        uint256[] memory w = Fixtures.wethAmounts();
        uint256[] memory u = Fixtures.usdcAmounts();
        uScale = uint96(bound(uScale, wScale == 0 ? 1 : 0, 1_000_000));
        for (uint256 i; i < w.length; ++i) {
            w[i] = (w[i] * wScale) / 1000;
            u[i] = (u[i] * uScale) / 1000;
        }
        uint256 wBefore = WETH.balanceOf(alice);
        uint256 uBefore = USDC.balanceOf(alice);
        vm.prank(alice);
        uint256 id = mgr.open(Fixtures.strategies(), w, u);
        vm.prank(alice);
        mgr.close(id);
        assertEq(WETH.balanceOf(alice), wBefore);
        assertEq(USDC.balanceOf(alice), uBefore);
        assertEq(WETH.balanceOf(address(mgr)), 0);
        assertEq(USDC.balanceOf(address(mgr)), 0);
    }

    // ---- adversarial ---------------------------------------------------------------------

    address constant ATTACKER = address(0xBAd1);

    function _fundAttacker() internal {
        _give(address(WETH), ATTACKER, 1 ether);
        _give(address(USDC), ATTACKER, 1_000e6);
        vm.startPrank(ATTACKER);
        WETH.approve(address(mgr), type(uint256).max);
        USDC.approve(address(mgr), type(uint256).max);
        vm.stopPrank();
    }

    function _openHostile(bytes memory strategy) internal returns (uint256) {
        bytes[] memory hs = new bytes[](1);
        hs[0] = strategy;
        uint256[] memory hw = new uint256[](1);
        hw[0] = 0.001 ether;
        uint256[] memory hu = new uint256[](1);
        hu[0] = 1e6;
        vm.prank(ATTACKER);
        return mgr.open(hs, hw, hu);
    }

    function _trySwap(bytes memory data, string memory label) internal returns (bool ok) {
        bytes memory ret;
        vm.prank(trader);
        (ok, ret) = ROUTER.call(data);
        emit log_named_string(label, ok ? "swap succeeded" : "swap reverted");
        if (!ok) emit log_named_bytes("  revert data", ret);
    }

    /// Alice has a normal position; the attacker opens `strategy` and a trader tries `swapData`
    /// against it. Whatever the router does, the pool must stay solvent and Alice must get every
    /// unit back, even when the attacker closes first.
    function _attack(bytes memory strategy, bytes memory swapData, string memory label) internal {
        _fundAttacker();
        uint256 aliceId = _open(alice);
        uint256 evilId = _openHostile(strategy);
        uint256 attackerUsdc = USDC.balanceOf(ATTACKER);
        uint256 attackerWeth = WETH.balanceOf(ATTACKER);

        _trySwap(swapData, label);

        uint256[] memory ids = new uint256[](2);
        ids[0] = aliceId;
        ids[1] = evilId;
        _assertBacked(ids);

        vm.prank(ATTACKER);
        mgr.close(evilId);
        // The attacker can never end with more than they put in plus what a trader paid in.
        // A trade here is 0.5 USDC; allow that much of USDC and no more WETH than they started with.
        assertLe(USDC.balanceOf(ATTACKER), attackerUsdc + 1e6 + 500_000, "attacker took USDC");
        assertLe(WETH.balanceOf(ATTACKER), attackerWeth + 0.001 ether, "attacker took WETH");

        uint256 aW = WETH.balanceOf(alice);
        uint256 aU = USDC.balanceOf(alice);
        vm.prank(alice);
        mgr.close(aliceId);
        assertEq(WETH.balanceOf(alice) - aW, _sum(Fixtures.wethAmounts()), "Alice lost WETH");
        assertEq(USDC.balanceOf(alice) - aU, _sum(Fixtures.usdcAmounts()), "Alice lost USDC");
        assertEq(WETH.balanceOf(address(mgr)), 0);
        assertEq(USDC.balanceOf(address(mgr)), 0);
    }

    /// Maker proceeds routed to the attacker: the router refuses it for Aqua orders.
    function test_attack_custom_receiver() public {
        _attack(Fixtures.hostileStrategy(), Fixtures.hostileSwap(), "customReceiver");
    }

    address constant HOOK = address(0xBAd2);

    function _installHook(uint256 aliceId) internal returns (MaliciousHook h) {
        vm.etch(HOOK, address(new MaliciousHook()).code);
        h = MaliciousHook(HOOK);
        (, , bytes32[] memory hs) = mgr.positionOf(aliceId);
        h.configure(address(mgr), address(AQUA), ROUTER, address(USDC), ATTACKER, hs[0], aliceId);
    }

    /// The attacker's strategy runs their own code inside every trade (a maker hook). That code
    /// tries to spend the manager's USDC, make Aqua pay out Alice's strategy, close Alice's
    /// position and dock her strategy. None of it may work, and Alice must get everything back.
    function test_attack_malicious_hook_contract() public {
        _fundAttacker();
        uint256 aliceId = _open(alice);
        MaliciousHook h = _installHook(aliceId);
        uint256 evilId = _openHostile(Fixtures.hookStrategy());

        assertTrue(_trySwap(Fixtures.hookSwap(), "malicious hook"), "the swap must go through so the hook runs");
        emit log_named_bytes32("hook selector", bytes32(h.selector()));
        emit log_named_uint("hook calldata size", h.size());
        assertTrue(h.ran(), "hook did not run");
        assertFalse(h.transferFromWorked(), "hook spent the manager's USDC");
        assertFalse(h.aquaPullWorked(), "hook made Aqua pay out a victim");
        assertFalse(h.closeVictimWorked(), "hook closed a victim's position");
        assertFalse(h.dockVictimWorked(), "hook docked a victim's strategy");

        uint256[] memory ids = new uint256[](2);
        ids[0] = aliceId;
        ids[1] = evilId;
        _assertBacked(ids);

        vm.prank(ATTACKER);
        mgr.close(evilId);
        uint256 aW = WETH.balanceOf(alice);
        uint256 aU = USDC.balanceOf(alice);
        vm.prank(alice);
        mgr.close(aliceId);
        assertEq(WETH.balanceOf(alice) - aW, _sum(Fixtures.wethAmounts()), "Alice lost WETH");
        assertEq(USDC.balanceOf(alice) - aU, _sum(Fixtures.usdcAmounts()), "Alice lost USDC");
        assertEq(WETH.balanceOf(address(mgr)), 0);
        assertEq(USDC.balanceOf(address(mgr)), 0);
    }
}
