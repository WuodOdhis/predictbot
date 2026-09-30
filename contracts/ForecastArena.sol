// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Sealed forecasts with explicitly operator-reported outcomes. No custody or betting.
contract ForecastArena {
    address public immutable operator;
    uint256 public nextRoundId = 1;

    struct Round {
        bytes32 rulesHash;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint64 observationStart;
        uint64 observationEnd;
        bool settled;
        bool cancelled;
        uint256 outcome;
        bytes32 evidenceHash;
    }
    struct Prediction {
        address submitter;
        bytes32 commitment;
        uint256 value;
        bool revealed;
    }
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(bytes32 => Prediction)) public predictions;

    event RoundCreated(uint256 indexed roundId, bytes32 rulesHash, uint64 commitDeadline, uint64 revealDeadline, uint64 observationStart, uint64 observationEnd);
    event Committed(uint256 indexed roundId, bytes32 indexed agentId, address submitter, bytes32 commitment);
    event Revealed(uint256 indexed roundId, bytes32 indexed agentId, uint256 value);
    event Settled(uint256 indexed roundId, uint256 outcome, bytes32 evidenceHash);
    event Cancelled(uint256 indexed roundId);

    constructor() { operator = msg.sender; }
    modifier onlyOperator() { require(msg.sender == operator, "Only operator"); _; }

    function createRound(bytes32 rulesHash, uint64 commitDeadline, uint64 revealDeadline, uint64 observationStart, uint64 observationEnd) external onlyOperator returns (uint256 id) {
        require(rulesHash != bytes32(0), "Missing rules");
        require(block.timestamp < commitDeadline && commitDeadline < revealDeadline && revealDeadline <= observationStart && observationStart < observationEnd, "Invalid deadlines");
        id = nextRoundId++;
        rounds[id] = Round(rulesHash, commitDeadline, revealDeadline, observationStart, observationEnd, false, false, 0, bytes32(0));
        emit RoundCreated(id, rulesHash, commitDeadline, revealDeadline, observationStart, observationEnd);
    }

    function commitmentFor(uint256 id, bytes32 agentId, address submitter, uint256 value, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), id, agentId, submitter, value, salt));
    }

    function commit(uint256 id, bytes32 agentId, bytes32 commitment) external onlyOperator {
        Round storage r = rounds[id];
        require(r.commitDeadline != 0 && !r.cancelled && block.timestamp < r.commitDeadline, "Commit closed");
        require(agentId != bytes32(0) && commitment != bytes32(0), "Empty commitment");
        require(predictions[id][agentId].submitter == address(0), "Already committed");
        predictions[id][agentId] = Prediction(msg.sender, commitment, 0, false);
        emit Committed(id, agentId, msg.sender, commitment);
    }

    function reveal(uint256 id, bytes32 agentId, uint256 value, bytes32 salt) external {
        Round storage r = rounds[id];
        require(!r.cancelled && block.timestamp >= r.commitDeadline && block.timestamp < r.revealDeadline, "Reveal closed");
        Prediction storage p = predictions[id][agentId];
        require(p.submitter == msg.sender && !p.revealed, "Not revealable");
        require(p.commitment == commitmentFor(id, agentId, msg.sender, value, salt), "Invalid reveal");
        p.value = value;
        p.revealed = true;
        emit Revealed(id, agentId, value);
    }

    function settle(uint256 id, uint256 outcome, bytes32 evidenceHash) external onlyOperator {
        Round storage r = rounds[id];
        require(r.commitDeadline != 0 && !r.cancelled && !r.settled && block.timestamp >= r.observationEnd, "Not settleable");
        require(evidenceHash != bytes32(0), "Missing evidence");
        r.outcome = outcome;
        r.evidenceHash = evidenceHash;
        r.settled = true;
        emit Settled(id, outcome, evidenceHash);
    }

    function cancel(uint256 id) external onlyOperator {
        Round storage r = rounds[id];
        require(r.commitDeadline != 0 && !r.settled && !r.cancelled, "Not cancellable");
        r.cancelled = true;
        emit Cancelled(id);
    }
}
