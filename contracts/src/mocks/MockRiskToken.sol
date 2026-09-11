// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Generic mintable ERC-20 used to seed the medium/high risk-tier
/// Uniswap pools on testnet (e.g. a project-token or meme-token stand-in)
/// when no sufficiently liquid real testnet pair exists — see PRD §7.6.
/// Deploy one instance per mocked asset (MockAAVE, MockMEME, ...).
contract MockRiskToken is ERC20, Ownable {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address initialOwner)
        ERC20(name_, symbol_)
        Ownable(initialOwner)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
