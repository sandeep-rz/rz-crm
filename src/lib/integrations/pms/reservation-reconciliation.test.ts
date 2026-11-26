import { test } from "node:test";
import assert from "node:assert/strict";
import { planReservationReconciliation as plan } from "./reservation-reconciliation";
const scope={accountId:"a",integrationId:"i",propertyId:"p"};
const parent={...scope,parentId:"parent",childIds:["child1","child2"]};
const row={...scope,id:"internal",externalId:"child1",contactId:"contact"};
test("preserve internal and contact IDs during rekey",()=>{
 assert.deepEqual(plan(parent,[row]),{kind:"rekey",parentId:"parent",internalId:"internal",contactId:"contact"});
});
test("existing canonical identity is kept",()=>{
 assert.equal(plan(parent,[{...row,externalId:"parent"}]).kind,"keep");
});
test("duplicate legacy rows are quarantined",()=>{
 assert.equal(plan(parent,[row,{...row,id:"other",externalId:"child2"}]).kind,"conflict");
});
test("property mismatch fails closed",()=>{
 assert.equal(plan(parent,[{...row,propertyId:"other"}]).kind,"conflict");
});
test("other accounts are ignored and no match is insert",()=>{
 assert.equal(plan(parent,[{...row,accountId:"other"}]).kind,"insert");
});
