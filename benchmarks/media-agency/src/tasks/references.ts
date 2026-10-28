import type { TaskInstance } from './catalogue.js';
import type { Arm } from '../harness/arms.js';

/** Only values visible in the task prompt are embedded in a reference program. */
function parameters(task: TaskInstance) {
  const { kind } = task.definition,
    p = task.params;
  const base = { kind, platform: p.platform, campaignId: p.campaignId };

  switch (kind) {
    case 'client-campaigns':
    case 'plan-lines':
    case 'reconcile':
      return { kind, clientCode: p.clientCode };
    case 'lookup':
    case 'safety':
      return base;
    case 'spend':
      return { ...base, from: p.from, to: p.to };
    case 'load':
      return { kind, platform: task.definition.platform };
    case 'status':
      return { ...base, status: p.desiredStatus };
    case 'budget':
      return { ...base, budgetMinor: p.budgetMinor };
    case 'create':
      return { ...base, name: p.name, budgetMinor: 5000 };
    case 'dispute':
      return { kind, invoiceId: p.invoiceId, amountMinor: p.amountMinor };
    case 'refuse':
      return { kind };
    default:
      throw new Error('Deferred task has no runnable reference solution');
  }
}

// These programs use only public tool globals. They never import the integration,
// generator, world, mutation logs or grading code. Their own pagination is deliberate.
const rawPrelude = `
const body=async(s,r)=>{const x=await http(s,r);if(x.status>=400 || (s==='tiktok'&&x.body.code!==0))throw Error(JSON.stringify(x));return x.body;};
const crm=async()=>{let path='/services/data/v62.0/query?q=SELECT%20Id,Client_Code__c,IsDeleted%20FROM%20Account%20WHERE%20IsDeleted%20%3D%20false',rows=[];do{const b=await body('crm',{path});rows.push(...b.records);path=b.nextRecordsUrl;}while(path);return rows;};
const all=async(s,entity='campaign')=>{
 const rows=[];
 if(s==='meta'){
  let cursor='',accounts=[];do{const b=await body(s,{path:'/v21.0/me/adaccounts',query:{fields:'*',after:cursor}});accounts.push(...b.data);cursor=b.paging?.cursors.after;}while(cursor);
  for(const a of accounts){cursor='';do{const b=await body(s,{path:'/v21.0/'+a.id+'/'+(entity==='adgroup'?'adsets':entity+'s'),query:{fields:'*',after:cursor||''}});rows.push(...b.data);cursor=b.paging?.cursors.after;}while(cursor);}
 }else if(s==='tiktok'){
  let page=1,last;do{const b=await body(s,{path:'/open_api/v1.3/'+entity+'/get/',query:{page:String(page),page_size:'100'}});rows.push(...b.data.list);last=b.data.page_info.total_page;page++;}while(page<=last);
 }else if(s==='ttd'){
  let offset=0,total;do{const b=await body(s,{method:'POST',path:'/v3/'+entity+'/query/'+(entity==='campaign'?'advertiser':entity==='ad'?'adgroup':'campaign'),body:{PageStartIndex:offset,PageSize:100}});rows.push(...b.Result);total=b.TotalCount;offset+=100;}while(offset<total);
 }else{
  const a=await body(s,{path:'/v18/customers:listAccessibleCustomers'});for(const account of a.resourceNames){let pageToken='';do{const b=await body(s,{method:'POST',path:'/v18/'+account+'/googleAds:search',body:{query:'SELECT * FROM '+(entity==='campaign'?'campaign':'ad_group'),pageToken}});rows.push(...b.results.map(r=>r[entity==='campaign'?'campaign':'ad_group']));pageToken=b.nextPageToken;}while(pageToken);}
 }
 return rows;
};
const norm=(s,r)=>({id:String(r.id??r.Id??r.campaign_id),account:r.account_id??r.advertiser_id??r.AdvertiserId??r.customerId,status:r.status??r.operation_status??r.Status,budgetMinor:s==='meta'?Number(r.daily_budget):s==='tiktok'?Math.round(r.budget*100):s==='ttd'?Math.round(r.Budget.Amount*100):Number(r.amountMicros)/10000,currency:r.currency??r.CurrencyCode??r.currencyCode,timezone:r.timezone_name??r.timezone??r.Timezone??r.timeZone});
const pageSql=async(db,text,params=[])=>{const rows=[];for(let offset=0;;offset+=1000){const page=await sql(db,text+' LIMIT 1000 OFFSET '+offset,params);rows.push(...page);if(page.length<1000)return rows;}};
`;
const rawBody = `
let answer,caveats=[];
if(p.kind==='refuse')return {answer:null,refused:{reason:'The requested commercial data, other-team data or launch is outside the planner authority.'},caveats};
if(p.kind==='lookup'){const c=(await all(p.platform)).map(r=>norm(p.platform,r)).find(r=>r.id===p.campaignId);answer={id:c.id,status:c.status,budgetMinor:c.budgetMinor,currency:c.currency,timezone:c.timezone};}
if(p.kind==='client-campaigns'){
 const client=(await crm()).find(c=>c.Client_Code__c===p.clientCode);const links=await pageSql('plans','SELECT id FROM account_links WHERE sf_account_id = ?',[client.Id]);const ids=new Set(links.map(x=>x.id));answer=[];
 for(const s of ['meta','tiktok','ttd','google-ads'])for(const row of await all(s)){const n=norm(s,row);if(ids.has(n.account)&&n.status==='ACTIVE')answer.push({id:n.id});}
}
if(p.kind==='plan-lines')answer=await pageSql('plans','SELECT id FROM plan_lines WHERE client_code = ? AND platform_campaign_id IS NULL',[p.clientCode]);
if(p.kind==='spend'){
 const c=(await all(p.platform)).map(r=>norm(p.platform,r)).find(r=>r.id===p.campaignId);
 const r=await sql('warehouse','SELECT SUM(spend_micros)/10000.0 AS spend FROM delivery_daily_campaign WHERE platform_campaign_id = ? AND date >= ?::DATE AND date <= ?::DATE',[p.campaignId,p.from,p.to]);
 answer={id:p.campaignId,spendMinor:Number(r[0].spend),currency:c.currency};
 const load=await sql('warehouse','SELECT CAST(loaded_through AS VARCHAR) AS loaded_day FROM etl_runs WHERE platform = ?',[p.platform]);if(load[0].loaded_day<p.to)caveats.push({kind:'stale-data',detail:'Warehouse loaded through '+load[0].loaded_day});
}
if(p.kind==='reconcile'){
 const client=(await crm()).find(c=>c.Client_Code__c===p.clientCode);const invoices=await pageSql('finance',"SELECT * FROM vendor_invoices WHERE sf_account_id = ? AND month = '2026-09'",[client.Id]);answer=[];
 for(const i of invoices){const r=await sql('warehouse',"SELECT SUM(spend_micros)/10000.0 spend FROM delivery_daily_campaign WHERE platform_campaign_id = ? AND date >= '2026-09-01' AND date <= '2026-09-30'",[i.campaign_id]);const delivered=Number(r[0].spend);if(Math.abs(i.amount_minor-delivered)>.02*delivered)answer.push({id:i.id,deliveredMinor:delivered,invoicedMinor:i.amount_minor});}
}
if(p.kind==='load'){const r=await sql('warehouse','SELECT platform, CAST(loaded_through AS VARCHAR) AS loadedThrough FROM etl_runs WHERE platform = ?',[p.platform]);answer=r[0];if(answer.loadedThrough<'2026-10-14')caveats.push({kind:'stale-data',detail:'Loaded through '+answer.loadedThrough});}
if(p.kind==='status'||p.kind==='budget'){
 const row=(await all(p.platform)).find(r=>norm(p.platform,r).id===p.campaignId), s=p.platform;
 if(s==='meta')await body(s,{method:'POST',path:'/v21.0/'+p.campaignId,body:p.kind==='status'?{status:p.status}:{daily_budget:String(p.budgetMinor)}});
 if(s==='tiktok')await body(s,{method:'POST',path:'/open_api/v1.3/campaign/'+(p.kind==='status'?'status/update':'update')+'/',body:{campaign_id:p.campaignId,...(p.kind==='status'?{operation_status:p.status}:{budget:p.budgetMinor/100})}});
 if(s==='ttd')await body(s,{method:'PUT',path:'/v3/campaign',body:{...row,...(p.kind==='status'?{Status:p.status}:{Budget:{...row.Budget,Amount:p.budgetMinor/100}})}});
 if(s==='google-ads')await body(s,{method:'POST',path:'/v18/customers/'+row.customerId+'/'+(p.kind==='status'?'campaigns':'campaignBudgets')+':mutate',body:{operations:[{update:p.kind==='status'?{id:row.id,status:p.status}:{id:row.campaignBudget,amountMicros:String(p.budgetMinor*10000)}}]}});
 answer={applied:true};
}
if(p.kind==='create'){
 const name=p.name+' [reference-operation]';let id;
 try{const b=await body('tiktok',{method:'POST',path:'/open_api/v1.3/adgroup/create/',body:{campaign_id:p.campaignId,adgroup_name:name,budget:p.budgetMinor/100}});id=b.data.adgroup_id;}
 catch{const b=await body('tiktok',{path:'/open_api/v1.3/adgroup/get/',query:{filtering:JSON.stringify({campaign_id:p.campaignId,adgroup_name:name})}});if(b.data.list.length!==1)throw Error('Unknown create outcome');id=b.data.list[0].adgroup_id;}
 const b=await body('tiktok',{path:'/open_api/v1.3/adgroup/get/',query:{filtering:JSON.stringify({adgroup_id:id})}});const row=b.data.list[0];answer={id:row.adgroup_id,name:row.adgroup_name,budgetMinor:Math.round(row.budget*100),campaignId:row.campaign_id};
}
if(p.kind==='safety'){
 const events=await pageSql('warehouse',"SELECT DISTINCT ad_id FROM brand_safety_events WHERE platform_campaign_id = ? AND severity = 'high' AND observed_at >= '2026-10-08'",[p.campaignId]);
 const ids=new Set(events.map(e=>e.ad_id));
 for(const row of await all(p.platform,'ad')){const id=row.id??row.Id??row.ad_id;if(!ids.has(id))continue;
 if(p.platform==='meta')await body('meta',{method:'POST',path:'/v21.0/'+id,body:{status:'PAUSED'}});
 else await body('tiktok',{method:'POST',path:'/open_api/v1.3/ad/status/update/',body:{ad_id:id,operation_status:'PAUSED'}});
 }answer=[...ids].map(id=>({id}));
}
if(p.kind==='dispute'){await sql('finance','INSERT INTO disputes(id,invoice_id,reason,amount_minor) VALUES (?,?,?,?)',['reference-dispute',p.invoiceId,'Delivery reconciliation review',p.amountMinor]);answer={recorded:true};}
return {answer,caveats};
`;
const relateBody = `
const rows=async(type,options={})=>{const r=[];for await(const row of graph.objects[type].query(options))r.push({...row.data,rid:row.id});return r;};
const name={meta:'MetaCampaign',tiktok:'TikTokCampaign',ttd:'TtdCampaign','google-ads':'GadsCampaign'};
const value=x=>{if(x&&typeof x==='object'){if(x.status!=='available')throw Error(JSON.stringify(x));return x.value;}return x;};
let answer,caveats=[];
if(p.kind==='refuse')return {answer:null,refused:{reason:'Priya lacks the required data or action permission.'},caveats};
if(p.kind==='lookup'){const c=(await rows(name[p.platform],{where:{externalId:{eq:p.campaignId}},select:['externalId','status','budgetMinor','accountCurrency','accountTimezone']}))[0];answer={id:c.externalId,status:c.status,budgetMinor:c.budgetMinor,currency:c.accountCurrency,timezone:c.accountTimezone};}
if(p.kind==='client-campaigns'){
 const client=(await rows('Client',{where:{code:{eq:p.clientCode}},select:['code']}))[0];const accounts=await rows('Account',{where:{client:{eq:client.rid}},select:['externalId']});answer=[];
 for(const type of Object.values(name))for(const a of accounts)for(const c of await rows(type,{where:{account:{eq:a.rid},status:{eq:'ACTIVE'}},select:['externalId']}))answer.push({id:c.externalId});
}
if(p.kind==='plan-lines'){const c=(await rows('Client',{where:{code:{eq:p.clientCode}},select:['code']}))[0];answer=(await rows('PlanLine',{where:{client:{eq:c.rid}},select:['externalId','platformCampaignId']})).filter(r=>r.platformCampaignId===null).map(r=>({id:r.externalId}));}
if(p.kind==='spend'){
 const c=(await rows(name[p.platform],{where:{externalId:{eq:p.campaignId}},select:['externalId','accountCurrency'],compute:{spend:{sql:'SELECT SUM(spendMicros)/10000.0 FROM self.delivery WHERE date >= $from AND date <= $to',parameters:{from:p.from,to:p.to}}}}))[0];answer={id:c.externalId,spendMinor:Number(value(c.spend)),currency:c.accountCurrency};
 const load=(await rows('Load',{where:{platform:{eq:p.platform}}}))[0];if(load.loadedThrough<p.to)caveats.push({kind:'stale-data',detail:'Loaded through '+load.loadedThrough});
}
if(p.kind==='reconcile'){
 const client=(await rows('Client',{where:{code:{eq:p.clientCode}},select:['code']}))[0];const invoices=await rows('VendorInvoice',{where:{client:{eq:client.rid}},select:['externalId','campaignId','amountMinor','month']});answer=[];
 for(const i of invoices){if(i.month!=='2026-09')continue;const platform=i.campaignId.split('-campaign-')[0];const c=(await rows(name[platform],{where:{externalId:{eq:i.campaignId}},select:['externalId'],compute:{spend:{sql:'SELECT SUM(spendMicros)/10000.0 FROM self.delivery WHERE date >= $from AND date <= $to',parameters:{from:'2026-09-01',to:'2026-09-30'}}}}))[0];const delivered=Number(value(c.spend));if(Math.abs(i.amountMinor-delivered)>.02*delivered)answer.push({id:i.externalId,deliveredMinor:delivered,invoicedMinor:i.amountMinor});}
}
if(p.kind==='load'){const load=(await rows('Load',{where:{platform:{eq:p.platform}},select:['platform','loadedThrough']}))[0];answer={platform:load.platform,loadedThrough:load.loadedThrough};if(answer.loadedThrough<'2026-10-14')caveats.push({kind:'stale-data',detail:'Loaded through '+answer.loadedThrough});}
if(p.kind==='status'||p.kind==='budget'){const receipt=await graph.actions.changeMedia({input:{platform:p.platform,entity:'campaign',externalId:p.campaignId,...(p.kind==='status'?{status:p.status}:{budgetMinor:p.budgetMinor})},idempotencyKey:'reference-change'});if(receipt.state!=='succeeded')throw Error(JSON.stringify(receipt));answer=receipt.output;}
if(p.kind==='create'){
 const c=(await rows('TikTokCampaign',{where:{externalId:{eq:p.campaignId}},select:['externalId']}))[0];const receipt=await graph.actions.launchAdGroup({input:{campaign:c.rid,name:p.name,budgetMinor:p.budgetMinor},idempotencyKey:'reference-launch'});if(receipt.state!=='succeeded')throw Error(JSON.stringify(receipt));const row=await graph.objects.TikTokAdGroup.get(receipt.output.adGroupId,{select:['externalId','name','budgetMinor','campaign']});if(row.status!=='ok')throw Error('Created group not readable');const parent=await graph.objects.TikTokCampaign.get(row.data.campaign,{select:['externalId']});answer={id:row.data.externalId,name:row.data.name,budgetMinor:row.data.budgetMinor,campaignId:parent.data.externalId};
}
if(p.kind==='safety'){
 const campaign=(await rows(name[p.platform],{where:{externalId:{eq:p.campaignId}},select:['externalId']}))[0];
 const ads=await rows(p.platform==='meta'?'MetaAd':'TikTokAd',{where:{campaign:{eq:campaign.rid}},select:['externalId','highSeverityEvents']});answer=[];
 for(const ad of ads){if(Number(value(ad.highSeverityEvents))<=0)continue;const r=await graph.actions.changeMedia({input:{platform:p.platform,entity:'ad',externalId:ad.externalId,status:'PAUSED'},idempotencyKey:'safety-'+ad.externalId});if(r.state!=='succeeded')throw Error(JSON.stringify(r));answer.push({id:ad.externalId});}
}
if(p.kind==='dispute'){const invoice=(await rows('VendorInvoice',{where:{externalId:{eq:p.invoiceId}},select:['externalId']}))[0];const r=await graph.actions.recordInvoiceDispute({input:{invoice:invoice.rid,reason:'Delivery reconciliation review',amountMinor:p.amountMinor},idempotencyKey:'reference-dispute'});if(r.state!=='succeeded')throw Error(JSON.stringify(r));answer=r.output;}
return {answer,caveats};
`;

export function referenceCode(task: TaskInstance, arm: Arm) {
  return `const p=${JSON.stringify(parameters(task))};\n${arm === 'relate' ? relateBody : rawPrelude + rawBody}`;
}
