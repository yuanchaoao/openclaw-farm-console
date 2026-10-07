import {buildOracleAuthorizationScript} from './oracle-authorization.mjs';
export function buildClientAuthorizationScript(publicKey, portRange) {
  return buildOracleAuthorizationScript({publicKey, port:portRange[0], portRange, client:true});
}
