import assert from 'node:assert/strict';
import {parseBridgeRestartPublicKey} from '../console/bridge-existing-probe.mjs';

const tag='3342e6f71fbb48768c930645b4c70b0f';
const key=`ssh-ed25519 ${'A'.repeat(68)} openclaw-tunnel`;
const prefix=`OPENCLAW_${tag}_`;
assert.equal(parseBridgeRestartPublicKey(`${prefix}PUBKEY_BEGIN\n${key}\n${prefix}PUBKEY_END\n${prefix}SERVICE_READY`,tag),key);
assert.equal(parseBridgeRestartPublicKey(`${prefix}PUBKEY_BEGIN\n${key}\n${prefix}SERVICE_READY`,tag),key);
assert.equal(parseBridgeRestartPublicKey(`${prefix}PUBKEY_BEGIN\n${key}`,tag),'');
assert.equal(parseBridgeRestartPublicKey(`${prefix}PUBKEY_BEGIN\n${key}\nOPENCLAW_${'f'.repeat(32)}_SERVICE_READY`,tag),'');
assert.equal(parseBridgeRestartPublicKey(`${prefix}PUBKEY_BEGIN\nnot-a-key\n${prefix}SERVICE_READY`,tag),'');
