/** Bounded granular permissions shared by the engine, console, and executor integrations. */
export type ResourceScalar = string | number | boolean | null;
export interface ResourceSelector { resource_type: string; operation: string }
export interface ResourceRequest extends ResourceSelector { version: 1; resource_id?: string }
export interface IdentityCondition {
  path: string; operator: 'eq' | 'in' | 'contains'; value: string | string[];
  required_source: 'authentication_verified'; identity_provider: string;
}
export interface ResourceFilter {
  field: string; operator: 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte';
  value?: ResourceScalar | ResourceScalar[]; value_from?: string;
  required_source?: 'authentication_verified'; identity_provider?: string;
}
export interface AccessLimits {
  allowed_fields?: string[]; required_filters?: ResourceFilter[];
  removed_fields?: string[]; masked_fields?: Array<{ field: string; method: string }>;
  max_rows?: number; max_bytes?: number; max_duration_ms?: number; max_result_age_ms?: number;
  allowed_destinations?: string[];
}
export interface ResourcePolicy {
  resource_selector?: ResourceSelector | null;
  context_conditions?: IdentityCondition[];
  access_limits?: AccessLimits | null;
}
export interface VerifiedResourceIdentity {
  provider: string; issuer: string; subject: string; trust_epoch: number;
  claims: Record<string, string | string[]>;
  /** Claims the provider withheld or sent in an unusable shape; conditions on them stay unknown. */
  unavailable_claims?: string[];
}
export interface ResourceContract {
  version: 1; resource: ResourceRequest; access_limits: AccessLimits;
  policy_versions: Array<{ id: string; version: number }>;
  authorization_hash: string;
}
const safe = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256 && !['__proto__','prototype','constructor'].includes(x);
const scalar = (x: unknown): x is ResourceScalar => x === null || typeof x === 'boolean' || typeof x === 'string' && x.length <= 1000 || typeof x === 'number' && Number.isFinite(x);
function object(x: unknown, keys: string[]): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some(k => !keys.includes(k))) throw new Error('Unsupported resource permission fields.');
  return x as Record<string, unknown>;
}
function strings(x: unknown): string[] {
  if (!Array.isArray(x) || x.length > 64 || !x.every(safe)) throw new Error('Use up to 64 short field names.');
  return [...new Set(x)].sort();
}
function path(x: unknown): string {
  if (!safe(x) || !x.startsWith('/subject/') || x.split('/').some(p => ['__proto__','prototype','constructor'].includes(p))) throw new Error('Use an allowlisted /subject/ identity path.');
  return x;
}
export function parseResourceSelector(x: unknown): ResourceSelector {
  const v = object(x, ['resource_type','operation']);
  if (!safe(v.resource_type) || !safe(v.operation)) throw new Error('Name the resource type and operation.');
  return { resource_type: v.resource_type, operation: v.operation };
}
export function parseResourceRequest(x: unknown): ResourceRequest {
  const v = object(x, ['version','resource_type','operation','resource_id']);
  if (v.version !== 1 || v.resource_id !== undefined && !safe(v.resource_id)) throw new Error('Use resource contract version 1 and a short resource identifier.');
  return { version: 1, ...parseResourceSelector({ resource_type:v.resource_type, operation:v.operation }), ...(v.resource_id === undefined ? {} : { resource_id:v.resource_id as string }) };
}
export function parseIdentityConditions(x: unknown): IdentityCondition[] {
  if (!Array.isArray(x) || x.length > 16) throw new Error('Use up to 16 identity conditions.');
  return x.map(raw => {
    const v=object(raw,['path','operator','value','required_source','identity_provider']);
    if (v.required_source !== 'authentication_verified' || !safe(v.identity_provider) || !['eq','in','contains'].includes(String(v.operator))) throw new Error('Choose a verified identity provider and supported condition.');
    const value = v.operator === 'in' ? strings(v.value) : v.value;
    if (v.operator !== 'in' && !safe(value)) throw new Error('Use a string identity condition value.');
    return {path:path(v.path),operator:v.operator as IdentityCondition['operator'],value:value as string|string[],required_source:'authentication_verified',identity_provider:v.identity_provider};
  });
}
export function parseAccessLimits(x: unknown): AccessLimits {
  const v=object(x,['allowed_fields','required_filters','removed_fields','masked_fields','max_rows','max_bytes','max_duration_ms','max_result_age_ms','allowed_destinations']);
  if (JSON.stringify(v).length > 16384) throw new Error('Access limits exceed 16 KB.');
  const out: AccessLimits={};
  for (const key of ['allowed_fields','removed_fields','allowed_destinations'] as const) if(v[key] !== undefined) out[key]=strings(v[key]);
  for (const key of ['max_rows','max_bytes','max_duration_ms','max_result_age_ms'] as const) if(v[key] !== undefined) {
    if (!Number.isSafeInteger(v[key]) || Number(v[key]) < 1 || Number(v[key]) > 1e12) throw new Error('Access ceilings must be positive bounded integers.');
    out[key]=v[key] as number;
  }
  if(v.masked_fields!==undefined) {
    if(!Array.isArray(v.masked_fields)||v.masked_fields.length>64)throw new Error('Use up to 64 field masks.');
    out.masked_fields=v.masked_fields.map(raw=>{const m=object(raw,['field','method']);if(!safe(m.field)||!safe(m.method))throw new Error('Specify a field and mask method.');return {field:m.field,method:m.method};});
  }
  if(v.required_filters!==undefined) {
    if(!Array.isArray(v.required_filters)||v.required_filters.length>32)throw new Error('Use up to 32 required filters.');
    out.required_filters=v.required_filters.map(raw=>{
      const f=object(raw,['field','operator','value','value_from','required_source','identity_provider']);
      if(!safe(f.field)||!['eq','in','gt','gte','lt','lte'].includes(String(f.operator)))throw new Error('Use a supported filter field and operator.');
      if(f.value_from!==undefined) {
        if(f.value!==undefined||f.required_source!=='authentication_verified'||!safe(f.identity_provider)||f.operator!=='eq')throw new Error('Bind an equality filter to one verified identity provider.');
        return {field:f.field,operator:f.operator as ResourceFilter['operator'],value_from:path(f.value_from),required_source:'authentication_verified',identity_provider:f.identity_provider};
      }
      if(f.required_source!==undefined||f.identity_provider!==undefined)throw new Error('Fixed filters cannot declare identity provenance.');
      if(f.operator==='in') {if(!Array.isArray(f.value)||f.value.length<1||f.value.length>32||!f.value.every(scalar))throw new Error('Use 1 to 32 scalar filter values.');}
      else if(!scalar(f.value)||f.operator!=='eq'&&typeof f.value!=='number')throw new Error('Use a value with the correct filter type.');
      return {field:f.field,operator:f.operator as ResourceFilter['operator'],value:f.value as ResourceFilter['value']};
    });
  }
  return out;
}
export function parseResourcePolicy(x: ResourcePolicy): ResourcePolicy {
  return {resource_selector:x.resource_selector==null?null:parseResourceSelector(x.resource_selector),context_conditions:parseIdentityConditions(x.context_conditions??[]),access_limits:x.access_limits==null?null:parseAccessLimits(x.access_limits)};
}
export function matchIdentityConditions(conditions: IdentityCondition[], identity?: VerifiedResourceIdentity | null): 'match'|'no_match'|'unknown' {
  let unknown=false;
  for(const c of conditions) {
    const value=identity?.provider===c.identity_provider?identity.claims[c.path]:undefined;
    if(value===undefined){unknown=true;continue;}
    if(c.operator==='contains') {if(!Array.isArray(value)){unknown=true;continue;}if(!value.includes(c.value as string))return 'no_match';}
    else {if(typeof value!=='string'){unknown=true;continue;}if(c.operator==='eq'?value!==c.value:!(c.value as string[]).includes(value))return 'no_match';}
  }
  return unknown?'unknown':'match';
}
/** Resolve only facts supplied by the server verifier; caller context is never consulted. */
export function resolveAccessLimits(limits: AccessLimits, identity?: VerifiedResourceIdentity|null): AccessLimits {
  const parsed=parseAccessLimits(limits);
  return {...parsed,...(parsed.required_filters?{required_filters:parsed.required_filters.map(f=>{
    if(!f.value_from)return f;
    const value=identity && identity.provider===f.identity_provider?identity.claims[f.value_from]:undefined;
    if(typeof value!=='string')throw new Error('A required filter has no verified identity value.');
    return {field:f.field,operator:f.operator,value};
  })}:{})};
}
/** Intersection, conjunction, and minimum ceilings never remove an existing restriction. */
export function combineAccessLimits(list: AccessLimits[]): AccessLimits {
  if(list.length>128)throw new Error('Too many matching resource restrictions.');
  const result: AccessLimits={};
  for(const raw of list) {
    const next=parseAccessLimits(raw);
    for(const key of ['allowed_fields','allowed_destinations'] as const) if(next[key]) {
      result[key]=result[key]?result[key]!.filter(v=>next[key]!.includes(v)):next[key];
      if(!result[key]!.length)throw new Error('Access limit intersection is empty.');
    }
    for(const key of ['max_rows','max_bytes','max_duration_ms','max_result_age_ms'] as const) if(next[key]!==undefined)result[key]=Math.min(result[key]??Infinity,next[key]!);
    result.removed_fields=[...new Set([...(result.removed_fields??[]),...(next.removed_fields??[])])].sort();
    result.required_filters=[...(result.required_filters??[]),...(next.required_filters??[])];
    result.masked_fields=[...(result.masked_fields??[]),...(next.masked_fields??[])];
  }
  const filters=result.required_filters??[];
  for(const f of filters) {
    if(f.value_from)throw new Error('Resolve identity references before combining access limits.');
    const same=filters.filter(g=>g.field===f.field);
    const equal=same.filter(g=>g.operator==='eq');
    const accepts=(g:ResourceFilter,v:ResourceScalar)=>g.operator==='eq'?v===g.value:g.operator==='in'?(g.value as ResourceScalar[]).includes(v):typeof v==='number'&&(g.operator==='gt'?v>Number(g.value):g.operator==='gte'?v>=Number(g.value):g.operator==='lt'?v<Number(g.value):v<=Number(g.value));
    if(equal.some(g=>!same.every(h=>accepts(h,g.value as ResourceScalar))))throw new Error('Required filters conflict.');
    const sets=same.filter(g=>g.operator==='in');
    if(sets.length&&!(sets[0].value as ResourceScalar[]).some(v=>same.every(h=>accepts(h,v))))throw new Error('Required filter membership is empty.');
    const lower=same.filter(g=>['gt','gte'].includes(g.operator));const upper=same.filter(g=>['lt','lte'].includes(g.operator));
    if(lower.some(l=>upper.some(u=>Number(l.value)>Number(u.value)||l.value===u.value&&(l.operator==='gt'||u.operator==='lt'))))throw new Error('Required filter bounds conflict.');
  }
  result.masked_fields=result.masked_fields?.filter(m=>!result.removed_fields?.includes(m.field));
  const masks=new Map<string,string>();
  for(const m of result.masked_fields??[]){if(masks.has(m.field)&&masks.get(m.field)!==m.method)throw new Error('Field masks conflict.');masks.set(m.field,m.method);}
  if(result.allowed_fields){result.allowed_fields=result.allowed_fields.filter(f=>!result.removed_fields?.includes(f));if(!result.allowed_fields.length)throw new Error('No permitted fields remain.');}
  // Remove duplicate filters and normalize order for stable authorization hashes.
  result.required_filters=[...new Map(filters.map(f=>[JSON.stringify(f),f])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  result.masked_fields=[...masks].sort(([a],[b])=>a.localeCompare(b)).map(([field,method])=>({field,method}));
  return parseAccessLimits(result);
}
