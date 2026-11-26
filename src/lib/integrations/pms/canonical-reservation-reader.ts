import 'server-only';
import { PmsHttpClient } from './http-client';
import { PmsProviderError } from './provider';
import type { PmsIntegrationContext } from './provider';
import { RUKIYE_ZARA_PROVIDER } from './types';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = () => new PmsProviderError('invalid_response','Invalid canonical reservation response.');
export type CanonicalRead = {kind:'native'|'pms'; reservation:Record<string,unknown>; parentId:string; aliases:string[]};

/** Only called after existing webhook authentication and tenant/property lookup.
 * Returns a validated read model, not a CRM upsert or automation request.
 */
export class CanonicalReservationReader {
  constructor(private readonly client: Pick<PmsHttpClient,'get'> = new PmsHttpClient()) {}
  async get(input:{integration:PmsIntegrationContext; externalPropertyId:string; externalReservationId:string; sourceType:string}):Promise<CanonicalRead> {
    if (input.integration.provider !== RUKIYE_ZARA_PROVIDER)
      throw new PmsProviderError('configuration','Invalid provider for canonical read.');
    if (!/^[1-9]\d*$/.test(input.externalPropertyId) || !uuid.test(input.externalReservationId) ||
      !['bookings','pms_bookings','pms_reservations'].includes(input.sourceType))
      throw new PmsProviderError('invalid_request','Invalid reservation scope.');
    const raw = await this.client.get<unknown>(
      '/v1/integrations/rz-crm/properties/'+encodeURIComponent(input.externalPropertyId)+'/canonical-reservations/'+encodeURIComponent(input.externalReservationId));
    if (!obj(raw) || raw.contract_version !== 'v2' || !obj(raw.data) || !obj(raw.data.reservation)) throw invalid();
    const r=raw.data.reservation;
    if (input.sourceType==='bookings') {
      if(raw.data.kind!=='native') throw invalid();
      const id=r.id;
      if(id!==input.externalReservationId || String(r.property_id ?? r.external_property_id)!==input.externalPropertyId) throw invalid();
      return {kind:'native',reservation:r,parentId:input.externalReservationId,aliases:[]};
    }
    if(raw.data.kind!=='pms' || typeof r.source_record_id!=='string' || !uuid.test(r.source_record_id) ||
       String(r.property_id)!==input.externalPropertyId || !Array.isArray(r.rooms)) throw invalid();
    const parentId=r.source_record_id;
    const aliases:string[]=[];
    for(const room of r.rooms){
      if(!obj(room)||typeof room.booking_id!=='string'||!uuid.test(room.booking_id)) throw invalid();
      aliases.push(room.booking_id);
    }
    if(new Set(aliases).size!==aliases.length || (input.sourceType==='pms_reservations' ? parentId!==input.externalReservationId :
      parentId!==input.externalReservationId && !aliases.includes(input.externalReservationId))) throw invalid();
    return {kind:'pms',reservation:r,parentId,aliases};
  }
}

/** Compare persisted event versions inside the same locked transaction as the
 * reservation update and automation enqueue. Do not use JS number coercion.
 * Legacy/unversioned events must use a separate compatibility path.
 */
export function compareCanonicalEventVersion(incoming:unknown,previous:unknown):'apply'|'duplicate_or_stale'|'invalid' {
  const parse=(v:unknown):bigint|null=>{
    if(typeof v==='number' && Number.isSafeInteger(v) && v>=0) return BigInt(v);
    if(typeof v==='string' && /^[0-9]{1,19}$/.test(v)) return BigInt(v);
    return null;
  };
  const a=parse(incoming),b=previous==null?BigInt(0):parse(previous);
  if(a===null||b===null||a<=BigInt(0)||a>BigInt('9223372036854775807')||b>BigInt('9223372036854775807'))return 'invalid';
  return a>b?'apply':'duplicate_or_stale';
}
