// Gateway pending requests expire after five minutes. Be conservative when copying.
export const PAIRING_COPY_MAX_AGE_MS=240000;
export function isDevicePairing(approval){return ['pairing_required','approval_required'].includes(approval?.stage);}
export function pairingFresh(approval,now=Date.now()){
 return isDevicePairing(approval) && Number.isFinite(approval.checkedAt) && now>=approval.checkedAt && now-approval.checkedAt<PAIRING_COPY_MAX_AGE_MS;
}
export function verifiedPairing(data,now=Date.now()){return {...data,checkedAt:Number.isFinite(data.checkedAt)?data.checkedAt:now};}
