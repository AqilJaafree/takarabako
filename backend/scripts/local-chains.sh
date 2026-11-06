#!/bin/bash
# (copied from the sandbox; needs anvil + foundry, and /tmp/cctp.hex from `forge inspect MockCctp deployedBytecode`)
# Fresh local Sepolia + Arc stand-ins with the contracts deployed; writes /tmp/demo.env
pkill anvil; sleep 1
(anvil --chain-id 5042002 --port 8545 > /tmp/anvil.log 2>&1 &); (anvil --chain-id 11155111 --port 8546 > /tmp/anvil2.log 2>&1 &); sleep 4
cd /home/user/app/takarabako/contracts; export FOUNDRY_SOLC_VERSION=0.8.28
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; DEP=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
setup() { R=$1; U=$(forge create src/mocks/MockUSDC.sol:MockUSDC --rpc-url $R --private-key $PK --broadcast --constructor-args $DEP 2>&1 | grep "Deployed to" | awk '{print $3}'); OUT=$(USDC_ADDRESS=$U forge script script/DeployCashChain.s.sol --rpc-url $R --broadcast --private-key $PK 2>&1); V=$(echo "$OUT" | grep "TakarabakoVault" | awk '{print $2}'); T=$(echo "$OUT" | grep "TakarabakoCashReceipt:" | awk '{print $2}'); cast send $U "mint(address,uint256)" $DEP 1000000000000 --rpc-url $R --private-key $PK >/dev/null
  for A in 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275; do cast rpc anvil_setCode $A "$(cat /tmp/cctp.hex)" --rpc-url $R >/dev/null; cast send $A "setUsdc(address)" $U --rpc-url $R --private-key $PK >/dev/null; cast send $U "mint(address,uint256)" $A 1000000000000 --rpc-url $R --private-key $PK >/dev/null; done; echo "$U $V $T"; }
ARC=($(setup http://127.0.0.1:8545)); SEP=($(setup http://127.0.0.1:8546))
cat > /tmp/demo.env <<EOF
PORT=4000
DATABASE_URL=postgres://takarabako:takarabako@localhost:5432/takarabako
CHAIN=sepolia
ENABLED_CHAINS=sepolia,arc-testnet
TREASURY_PRIVATE_KEY=$PK
SEPOLIA_RPC_URL=http://127.0.0.1:8546
SEPOLIA_USDC_ADDRESS=${SEP[0]}
SEPOLIA_VAULT_ADDRESS=${SEP[1]}
SEPOLIA_CASH_RECEIPT_ADDRESS=${SEP[2]}
ARC_TESTNET_RPC_URL=http://127.0.0.1:8545
ARC_TESTNET_USDC_ADDRESS=${ARC[0]}
ARC_TESTNET_VAULT_ADDRESS=${ARC[1]}
ARC_TESTNET_CASH_RECEIPT_ADDRESS=${ARC[2]}
PRIVY_APP_ID=cm0000000000000000000000a
PRIVY_APP_SECRET=demo
OPS_ADMIN_TOKEN=demo-operator
AQUA_SIM=0
AGENT_REPORTS=off
KIOSK_ID=tokyo-01
EOF
# enable the Arc kiosk id in tkCASH (an operator step for every new kiosk id)
cast send ${ARC[2]} "setKiosk(bytes32,bool)" $(cast format-bytes32-string arc-01) true --rpc-url http://127.0.0.1:8545 --private-key $PK >/dev/null
echo ready
