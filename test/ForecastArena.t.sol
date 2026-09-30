// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../contracts/ForecastArena.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes calldata) external;
}

contract ForecastArenaTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ForecastArena arena;
    bytes32 constant AGENT = keccak256("model-a");
    bytes32 constant SALT = keccak256("secret");

    function setUp() public {
        vm.warp(100);
        arena = new ForecastArena();
        arena.createRound(keccak256("rules"), 200, 300, 300, 400);
    }
    function testFullLifecycleAndZeroOutcome() public {
        arena.commit(1, AGENT, arena.commitmentFor(1, AGENT, address(this), 42, SALT));
        vm.warp(200);
        arena.reveal(1, AGENT, 42, SALT);
        (, , uint256 value, bool revealed) = arena.predictions(1, AGENT);
        require(revealed && value == 42, "Wrong reveal");
        vm.warp(400);
        arena.settle(1, 0, keccak256("evidence"));
        (, , , , , bool settled, , uint256 outcome, ) = arena.rounds(1);
        require(settled && outcome == 0, "Zero outcome not settled");
    }
    function testCannotOverwriteOrRevealWrongValue() public {
        bytes32 commitment = arena.commitmentFor(1, AGENT, address(this), 42, SALT);
        arena.commit(1, AGENT, commitment);
        vm.expectRevert(bytes("Already committed"));
        arena.commit(1, AGENT, commitment);
        vm.warp(200);
        vm.expectRevert(bytes("Invalid reveal"));
        arena.reveal(1, AGENT, 43, SALT);
    }
    function testDeadlinesAndOwnership() public {
        vm.expectRevert(bytes("Only operator"));
        vm.prank(address(0xBEEF));
        arena.commit(1, AGENT, bytes32(uint256(1)));
        vm.warp(200);
        vm.expectRevert(bytes("Commit closed"));
        arena.commit(1, AGENT, bytes32(uint256(1)));
        vm.expectRevert(bytes("Not settleable"));
        arena.settle(1, 4, keccak256("evidence"));
    }
    function testCancellationStopsRevealAndSettlement() public {
        arena.commit(1, AGENT, arena.commitmentFor(1, AGENT, address(this), 42, SALT));
        arena.cancel(1);
        vm.warp(200);
        vm.expectRevert(bytes("Reveal closed"));
        arena.reveal(1, AGENT, 42, SALT);
        vm.warp(400);
        vm.expectRevert(bytes("Not settleable"));
        arena.settle(1, 4, keccak256("evidence"));
    }
    function testCommitmentBoundToRoundAgentAndSubmitter() public view {
        bytes32 c = arena.commitmentFor(1, AGENT, address(this), 42, SALT);
        require(c != arena.commitmentFor(2, AGENT, address(this), 42, SALT), "Round replay");
        require(c != arena.commitmentFor(1, keccak256("b"), address(this), 42, SALT), "Agent replay");
        require(c != arena.commitmentFor(1, AGENT, address(0xBEEF), 42, SALT), "Sender replay");
    }
}
