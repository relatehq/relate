import type { TaskInstance } from './catalogue.js';
import type { Arm } from '../harness/arms.js';

/** Only values visible in the task prompt are embedded in a reference program. */
function parameters(task: TaskInstance) {
  const { kind } = task.definition,
    p = task.params;
  const named = { kind, clientCode: p.clientCode, name: p.name };

  switch (kind) {
    case 'client-campaigns':
    case 'plan-lines':
    case 'reconcile':
    case 'load':
    case 'safety':
    case 'pacing':
      return { kind, clientCode: p.clientCode };
    case 'fx':
      return { kind, clientCode: p.clientCode, from: p.from, to: p.to };
    case 'lookup':
      return named;
    case 'spend':
      return { ...named, from: p.from, to: p.to };
    case 'mixed':
      return {
        ...named,
        otherClientCode: p.otherClientCode,
        otherName: p.otherName,
      };
    case 'status':
      return { ...named, status: p.desiredStatus };
    case 'budget':
      return { ...named, budgetMinor: p.budgetMinor };
    case 'create':
      return {
        kind,
        clientCode: p.clientCode,
        campaignName: p.otherName,
        name: p.name,
        budgetMinor: 5000,
      };
    case 'dispute':
      return { kind, invoiceId: p.invoiceId, amountMinor: p.amountMinor };
    case 'refuse':
      return { kind };
    case 'rebalance':
      return { kind, clientCode: p.clientCode };
  }
}

// These programs use only public tool globals. They never import the integration,
// generator, world, mutation logs or grading code. Their own pagination is deliberate.
const rawPrelude = `
const platforms=['meta','tiktok','ttd','google-ads'];
const channelOf=s=>s==='meta'||s==='tiktok'?'social':s==='ttd'?'programmatic':'search';
const failed=(s,x)=>x.status>=400||(s==='tiktok'&&x.body.code!==0);
const body=async(s,r)=>{const x=await http(s,r);if(failed(s,x))throw Error(JSON.stringify(x));return x.body;};
const crmRows=async()=>{let path='/services/data/v62.0/query?q='+encodeURIComponent('SELECT Id,Client_Code__c,Team__c,CurrencyIsoCode,IsDeleted,MasterRecordId FROM Account'),rows=[];do{const b=await body('crm',{path});rows.push(...b.records);path=b.nextRecordsUrl;}while(path);return rows;};
const crm=await crmRows();
const master=id=>{const r=crm.find(c=>c.Id===id);return r&&r.IsDeleted?r.MasterRecordId:id;};
const clientBy=code=>crm.find(c=>c.Client_Code__c===code&&!c.IsDeleted);
const canonical=(platform,id)=>platform==='google-ads'?id.replaceAll('-',''):id;
const pageSql=async(db,text,params=[])=>{const rows=[];for(let offset=0;;offset+=1000){const page=await sql(db,text+' LIMIT 1000 OFFSET '+offset,params);rows.push(...page);if(page.length<1000)return rows;}};
const links=await pageSql('plans','SELECT id,sf_account_id,platform FROM account_links ORDER BY id');
const accountsOf=clientId=>links.filter(l=>master(l.sf_account_id)===clientId).map(l=>({id:canonical(l.platform,l.id),platform:l.platform}));
const cache=new Map();
const all=async(s,entity='campaign')=>{
 const key=s+':'+entity;if(cache.has(key))return cache.get(key);
 const rows=[];
 if(s==='meta'){
  let cursor='',accounts=[];do{const b=await body(s,{path:'/v21.0/me/adaccounts',query:{fields:'*',limit:'100',...(cursor?{after:cursor}:{})}});accounts.push(...b.data);cursor=b.paging?.cursors.after;}while(cursor);
  for(const a of accounts){cursor='';do{const b=await body(s,{path:'/v21.0/'+a.id+'/'+(entity==='adgroup'?'adsets':entity+'s'),query:{fields:'*',limit:'100',...(cursor?{after:cursor}:{})}});rows.push(...b.data);cursor=b.paging?.cursors.after;}while(cursor);}
 }else if(s==='tiktok'){
  let page=1,last;do{const b=await body(s,{path:'/open_api/v1.3/'+entity+'/get/',query:{page:String(page),page_size:'200'}});rows.push(...b.data.list);last=b.data.page_info.total_page;page++;}while(page<=last);
 }else if(s==='ttd'){
  let offset=0,total;do{const b=await body(s,{method:'POST',path:'/v3/'+entity+'/query/'+(entity==='campaign'?'advertiser':entity==='ad'?'adgroup':'campaign'),body:{PageStartIndex:offset,PageSize:200}});rows.push(...b.Result);total=b.TotalCount;offset+=200;}while(offset<total);
 }else{
  const resource=entity==='campaign'?'campaign':entity==='ad'?'ad_group_ad':'ad_group';
  const a=await body(s,{path:'/v18/customers:listAccessibleCustomers'});for(const account of a.resourceNames){let pageToken='';do{const b=await body(s,{method:'POST',path:'/v18/'+account+'/googleAds:search',body:{query:'SELECT * FROM '+resource,pageToken}});rows.push(...b.results.map(r=>r[resource]));pageToken=b.nextPageToken;}while(pageToken);}
 }
 cache.set(key,rows);return rows;
};
const norm=(s,r)=>({raw:r,platform:s,id:String(r.Id??r.ad_id??r.adgroup_id??r.id??r.campaign_id),campaignId:String(r.CampaignId??r.campaignId??r.campaign_id??r.id),account:String(r.account_id??r.advertiser_id??r.AdvertiserId??r.customerId),name:r.name??r.Name??r.campaign_name??r.adgroup_name??r.ad_name,status:r.status??r.operation_status??r.Status,budgetMinor:s==='meta'?Number(r.daily_budget):s==='tiktok'?Math.round(r.budget*100):s==='ttd'?Math.round(r.Budget.Amount*100):Number(r.amountMicros)/10000,currency:r.currency??r.CurrencyCode??r.currencyCode,timezone:r.timezone_name??r.timezone??r.Timezone??r.timeZone,budgetId:r.campaignBudget});
const campaignsOf=async clientId=>{const ids=new Set(accountsOf(clientId).map(a=>a.id)),out=[];for(const s of platforms)for(const row of await all(s))if(ids.has(norm(s,row).account))out.push(norm(s,row));return out;};
const byName=async(code,name)=>(await campaignsOf(clientBy(code).Id)).filter(c=>c.name===name);
const loads=new Map((await sql('warehouse','SELECT platform_account_id, CAST(loaded_through AS VARCHAR) AS d FROM etl_runs')).map(r=>[r.platform_account_id,r.d]));
const days=(a,b)=>Math.round((Date.parse(b)-Date.parse(a))/86400000)+1;
const converted=async(campaignId,to,from,through)=>Number((await sql('warehouse','SELECT COALESCE(SUM(d.spend_micros/10000.0*f.rate),0) AS v FROM delivery_daily_campaign d JOIN fx_daily f ON f.date=d.date AND f.from_currency=d.currency AND f.to_currency=? WHERE d.platform_campaign_id=? AND d.date>=?::DATE AND d.date<=?::DATE',[to,campaignId,from,through]))[0].v);
const write=async(s,request,verify)=>{for(let attempt=0;attempt<4;attempt++){try{const x=await http(s,request);if(!failed(s,x))return x.body;if(!(x.status===429||x.status>=500||x.body?.code===40100||x.body?.code===50000))throw Error('rejected '+JSON.stringify(x.body));}catch(e){if(String(e).includes('rejected'))throw e;if(await verify())return {recovered:true};}}throw Error('write failed');};
const readAd=async(s,id)=>{const r=s==='meta'?await body(s,{path:'/v21.0/'+id,query:{fields:'*'}}):s==='tiktok'?(await body(s,{path:'/open_api/v1.3/ad/get/',query:{filtering:JSON.stringify({ad_id:id})}})).data.list[0]:s==='ttd'?await body(s,{path:'/v3/ad/'+id}):(await all(s,'ad')).find(a=>a.id===id);return norm(s,r);};
const pacingOf=async code=>{const client=clientBy(code),lines=await pageSql('plans','SELECT * FROM plan_lines WHERE sf_account_id = ? AND platform_campaign_id IS NOT NULL ORDER BY id',[client.Id]),out=[];
 for(const l of lines){const acct=(await sql('warehouse','SELECT DISTINCT platform_account_id AS a FROM delivery_daily_campaign WHERE platform_campaign_id = ?',[l.platform_campaign_id]))[0]?.a;const loaded=loads.get(acct)??'2026-10-14';const through=loaded<l.flight_end?loaded:l.flight_end;const spent=await converted(l.platform_campaign_id,l.currency,l.flight_start,through);out.push({line:l,pct:100*spent/(l.budget_minor*days(l.flight_start,through)/days(l.flight_start,l.flight_end))});}
 return out;};
`;
const rawBody = `
let answer=null,caveats=[];
if(p.kind==='refuse')return {answer:null,refused:{reason:'The requested commercial data, other-team data, budget move, shared budget or ended-flight change is outside authority or policy.'},caveats};
if(p.kind==='lookup'){const m=await byName(p.clientCode,p.name);if(m.length!==1)return {answer:null,caveats:[{kind:'not-found',detail:'No exact unambiguous campaign named '+p.name}]};const c=m[0];answer={id:c.id,platform:c.platform,status:c.status,budgetMinor:c.budgetMinor,currency:c.currency,timezone:c.timezone};}
if(p.kind==='client-campaigns')answer=(await campaignsOf(clientBy(p.clientCode).Id)).filter(c=>c.status==='ACTIVE').map(c=>({id:c.id,platform:c.platform}));
if(p.kind==='plan-lines')answer=await pageSql('plans','SELECT id FROM plan_lines WHERE client_code = ? AND platform_campaign_id IS NULL',[p.clientCode]);
if(p.kind==='spend'||p.kind==='mixed'){
 const one=async(code,name,from,to)=>{const c=(await byName(code,name))[0];const r=await sql('warehouse','SELECT COALESCE(SUM(spend_micros)/10000.0,0) AS spend FROM delivery_daily_campaign WHERE platform_campaign_id = ? AND date >= ?::DATE AND date <= ?::DATE',[c.id,from,to]);if(loads.get(c.account)<to)caveats.push({kind:'stale-data',detail:'Account '+c.account+' loaded through '+loads.get(c.account)});return {id:c.id,spendMinor:Number(r[0].spend),currency:c.currency};};
 if(p.kind==='spend')answer=await one(p.clientCode,p.name,p.from,p.to);
 else{answer=[];for(const [code,name] of [[p.clientCode,p.name],[p.otherClientCode,p.otherName]]){if(clientBy(code).Team__c!=='retail'){caveats.push({kind:'permission',detail:code+' is not a retail client'});continue;}answer.push(await one(code,name,'2026-10-01','2026-10-12'));}caveats=caveats.filter(c=>c.kind!=='stale-data');}
}
if(p.kind==='fx'){
 const client=clientBy(p.clientCode),accounts=accountsOf(client.Id);const ids=accounts.map(a=>a.id);
 const rows=await sql('warehouse','SELECT d.platform, SUM(d.spend_micros/10000.0*f.rate) AS v FROM delivery_daily_campaign d JOIN fx_daily f ON f.date=d.date AND f.from_currency=d.currency AND f.to_currency=? WHERE d.platform_account_id IN ('+ids.map(()=>'?').join(',')+') AND d.date>=?::DATE AND d.date<=?::DATE GROUP BY d.platform',[client.CurrencyIsoCode,...ids,p.from,p.to]);
 const totals=new Map();for(const r of rows)totals.set(channelOf(r.platform),(totals.get(channelOf(r.platform))??0)+Number(r.v));
 answer=[...totals].filter(([,v])=>v>0).map(([channel,spendMinor])=>({channel,spendMinor,currency:client.CurrencyIsoCode}));
 for(const id of ids)if(loads.get(id)<p.to)caveats.push({kind:'stale-data',detail:'Account '+id+' loaded through '+loads.get(id)});
}
if(p.kind==='reconcile'){
 const client=clientBy(p.clientCode);const rows=(await pageSql('finance',"SELECT * FROM vendor_invoices WHERE month = '2026-09' ORDER BY id")).filter(i=>master(i.sf_account_id)===client.Id);answer=[];
 for(const i of rows.filter(i=>i.kind==='invoice')){const net=i.amount_minor+rows.filter(c=>c.credit_for===i.id).reduce((s,c)=>s+c.amount_minor,0);const r=await sql('warehouse',"SELECT COALESCE(SUM(spend_micros)/10000.0,0) spend FROM delivery_daily_campaign WHERE platform_campaign_id = ? AND date >= '2026-09-01' AND date <= '2026-09-30'",[i.campaign_id]);const delivered=Number(r[0].spend);if(Math.abs(net-delivered)>.02*delivered)answer.push({id:i.id,deliveredMinor:delivered,invoicedMinor:net});}
}
if(p.kind==='load'){answer=accountsOf(clientBy(p.clientCode).Id).map(a=>({accountId:a.id,platform:a.platform,loadedThrough:loads.get(a.id)}));for(const a of answer)if(a.loadedThrough<'2026-10-14')caveats.push({kind:'stale-data',detail:'Account '+a.accountId+' loaded through '+a.loadedThrough});}
const change=async(c,status,budgetMinor)=>{const s=c.platform,row=c.raw,read=async()=>norm(s,s==='meta'?await body(s,{path:'/v21.0/'+c.id,query:{fields:'*'}}):s==='tiktok'?(await body(s,{path:'/open_api/v1.3/campaign/get/',query:{filtering:JSON.stringify({campaign_id:c.id})}})).data.list[0]:s==='ttd'?await body(s,{path:'/v3/campaign/'+c.id}):(await body(s,{method:'POST',path:'/v18/customers/'+c.account+'/googleAds:search',body:{query:"SELECT * FROM campaign WHERE campaign.id = '"+c.id+"'"}})).results[0].campaign);const verify=async()=>{const n=await read();return status?n.status===status:n.budgetMinor===budgetMinor;};
 if(s==='meta')await write(s,{method:'POST',path:'/v21.0/'+c.id,body:status?{status}:{daily_budget:String(budgetMinor)}},verify);
 if(s==='tiktok')await write(s,{method:'POST',path:'/open_api/v1.3/campaign/'+(status?'status/update':'update')+'/',body:{campaign_id:c.id,...(status?{operation_status:status}:{budget:budgetMinor/100})}},verify);
 if(s==='ttd')await write(s,{method:'PUT',path:'/v3/campaign',body:{...row,...(status?{Status:status}:{Budget:{...row.Budget,Amount:budgetMinor/100}})}},verify);
 if(s==='google-ads')await write(s,{method:'POST',path:'/v18/customers/'+c.account+'/'+(status?'campaigns':'campaignBudgets')+':mutate',body:{operations:[{update:status?{id:c.id,status}:{id:row.campaignBudget,amountMicros:String(budgetMinor*10000)}}]}},verify);};
if(p.kind==='status'||p.kind==='budget'){const c=(await byName(p.clientCode,p.name))[0];await change(c,p.kind==='status'?p.status:undefined,p.kind==='budget'?p.budgetMinor:undefined);answer={applied:true};}
if(p.kind==='create'){
 const c=(await byName(p.clientCode,p.campaignName))[0];const name=p.name+' [reference-operation]';let id;
 try{const b=await body('tiktok',{method:'POST',path:'/open_api/v1.3/adgroup/create/',body:{campaign_id:c.id,adgroup_name:name,budget:p.budgetMinor/100}});id=b.data.adgroup_id;}
 catch{const b=await body('tiktok',{path:'/open_api/v1.3/adgroup/get/',query:{filtering:JSON.stringify({campaign_id:c.id,adgroup_name:name})}});if(b.data.list.length!==1)throw Error('Unknown create outcome');id=b.data.list[0].adgroup_id;}
 const b=await body('tiktok',{path:'/open_api/v1.3/adgroup/get/',query:{filtering:JSON.stringify({adgroup_id:id})}});const row=b.data.list[0];answer={id:row.adgroup_id,name:row.adgroup_name,budgetMinor:Math.round(row.budget*100),campaignId:row.campaign_id};
}
if(p.kind==='safety'){
 const client=clientBy(p.clientCode),campaigns=await campaignsOf(client.Id),ids=new Set(campaigns.map(c=>c.id));
 const events=await pageSql('warehouse',"SELECT DISTINCT ad_id, platform_campaign_id FROM brand_safety_events WHERE severity = 'high' AND observed_at >= '2026-10-08' ORDER BY ad_id");
 const lines=await pageSql('plans',"SELECT platform_campaign_id FROM plan_lines WHERE platform_campaign_id IS NOT NULL AND flight_end >= '2026-10-15'");const open=new Set(lines.map(l=>l.platform_campaign_id));
 answer=[];const skipped=[];
 for(const e of events.filter(e=>ids.has(e.platform_campaign_id))){if(!open.has(e.platform_campaign_id)){skipped.push(e.ad_id);continue;}const s=campaigns.find(c=>c.id===e.platform_campaign_id).platform;const ad=(await all(s,'ad')).map(r=>norm(s,r)).find(a=>a.id===e.ad_id);const verify=async()=>(await readAd(s,ad.id)).status==='PAUSED';
  if(s==='meta')await write(s,{method:'POST',path:'/v21.0/'+ad.id,body:{status:'PAUSED'}},verify);
  if(s==='tiktok')await write(s,{method:'POST',path:'/open_api/v1.3/ad/status/update/',body:{ad_id:ad.id,operation_status:'PAUSED'}},verify);
  if(s==='ttd')await write(s,{method:'PUT',path:'/v3/ad',body:{...ad.raw,Status:'PAUSED'}},verify);
  if(s==='google-ads')await write(s,{method:'POST',path:'/v18/customers/'+ad.account+'/adGroupAds:mutate',body:{operations:[{update:{id:ad.id,status:'PAUSED'}}]}},verify);
  answer.push({id:ad.id});}
 if(skipped.length)caveats.push({kind:'partial-action',detail:'Skipped ads in ended or unlinked campaigns: '+skipped.join(', ')});
}
if(p.kind==='pacing')answer=(await pacingOf(p.clientCode)).filter(x=>x.pct>110||x.pct<85).map(x=>({id:x.line.id,pacingPct:Math.round(x.pct*10)/10,state:x.pct>110?'over':'under'}));
if(p.kind==='rebalance'){
 const campaigns=await campaignsOf(clientBy(p.clientCode).Id);const google=await all('google-ads');
 const ok=(await pacingOf(p.clientCode)).filter(x=>x.line.flight_end>='2026-10-15').map(x=>({...x,c:campaigns.find(c=>c.id===x.line.platform_campaign_id)})).filter(x=>x.c&&(x.c.platform!=='google-ads'||google.filter(g=>g.campaignBudget===x.c.budgetId).length===1)).sort((a,b)=>b.pct-a.pct);
 const top=ok[0],newBudgetMinor=Math.floor(top.c.budgetMinor*0.85);await change(top.c,undefined,newBudgetMinor);answer={planLineId:top.line.id,campaignId:top.c.id,newBudgetMinor};
}
if(p.kind==='dispute'){await sql('finance','INSERT INTO disputes(id,invoice_id,reason,amount_minor) VALUES (?,?,?,?)',['reference-dispute',p.invoiceId,'Delivery reconciliation review',p.amountMinor]);answer={recorded:true};}
return {answer,caveats};
`;
const relateBody = `
const rows=async(type,options={})=>{const r=[];for await(const row of graph.objects[type].query(options))r.push({...row.data,rid:row.id});return r;};
const types={meta:'MetaCampaign',tiktok:'TikTokCampaign',ttd:'TtdCampaign','google-ads':'GadsCampaign'};
const adTypes={meta:'MetaAd',tiktok:'TikTokAd',ttd:'TtdAd','google-ads':'GadsAd'};
const channelOf=s=>s==='meta'||s==='tiktok'?'social':s==='ttd'?'programmatic':'search';
const value=x=>{if(x&&typeof x==='object'){if(x.status!=='available')throw Error(JSON.stringify(x));return x.value;}return x;};
const client=async code=>(await rows('Client',{where:{code:{eq:code}},select:['code','currency','team']}))[0];
const accountsOf=async c=>rows('Account',{where:{client:{eq:c.rid}},select:['externalId','platform']});
const select=['externalId','name','status','budgetMinor','accountCurrency','accountTimezone','budgetId','account'];
const campaignsOf=async c=>{const out=[];for(const a of await accountsOf(c))for(const r of await rows(types[a.platform],{where:{account:{eq:a.rid}},select}))out.push({...r,platform:a.platform,accountExternalId:a.externalId});return out;};
const byName=async(code,name)=>{const c=await client(code);return c?(await campaignsOf(c)).filter(r=>r.name===name):[];};
const byExternal=async id=>{for(const [platform,type] of Object.entries(types)){const r=(await rows(type,{where:{externalId:{eq:id}},select}))[0];if(r)return {...r,platform};}};
const loadOf=async accountExternalId=>(await rows('Load',{where:{accountExternalId:{eq:accountExternalId}},select:['loadedThrough']}))[0].loadedThrough;
const accountOfCampaign=async c=>(await graph.objects.Account.get(c.account,{select:['externalId']})).data.externalId;
const datesBetween=(a,b)=>{const out=[];for(let t=Date.parse(a);t<=Date.parse(b);t+=86400000)out.push(new Date(t).toISOString().slice(0,10));return out;};
const rateCache=new Map();
const ratesFor=async(from,to)=>{const key=from+to;if(!rateCache.has(key))rateCache.set(key,new Map((await rows('FxRate',{where:{fromCurrency:{eq:from},toCurrency:{eq:to}},select:['date','rate']})).map(r=>[r.date,r.rate])));return rateCache.get(key);};
// No reference-dataset join yet: sum per day (8 expressions per query) and convert in code.
const dailySpend=async(type,where,dates)=>{const totals=new Map();for(let i=0;i<dates.length;i+=8){const chunk=dates.slice(i,i+8),compute={};chunk.forEach((d,j)=>compute['d'+j]={sql:'SELECT SUM(spendMicros)/10000.0 FROM self.delivery WHERE date = $day',parameters:{day:d}});for await(const row of graph.objects[type].query({where,select:['externalId','accountCurrency'],compute})){const t=totals.get(row.data.externalId)??{currency:row.data.accountCurrency,days:new Map()};chunk.forEach((d,j)=>t.days.set(d,Number(value(row.data['d'+j])??0)));totals.set(row.data.externalId,t);}}return totals;};
const convertedFor=async(totals,to)=>{let sum=0;for(const t of totals.values()){const rates=await ratesFor(t.currency,to);for(const [d,v] of t.days)sum+=v*rates.get(d);}return sum;};
const days=(a,b)=>Math.round((Date.parse(b)-Date.parse(a))/86400000)+1;
const pacingOf=async code=>{const c=await client(code),out=[];for(const line of await rows('PlanLine',{where:{client:{eq:c.rid}},select:['externalId','platformCampaignId','budgetMinor','currency','flightStart','flightEnd']})){if(line.platformCampaignId===null)continue;const campaign=await byExternal(line.platformCampaignId);const loaded=await loadOf(await accountOfCampaign(campaign));const through=loaded<line.flightEnd?loaded:line.flightEnd;const spent=await convertedFor(await dailySpend(types[campaign.platform],{externalId:{eq:campaign.externalId}},datesBetween(line.flightStart,through)),line.currency);out.push({line,campaign,pct:100*spent/(line.budgetMinor*days(line.flightStart,through)/days(line.flightStart,line.flightEnd))});}return out;};
const spendOf=async(c,from,to)=>{const r=(await rows(types[c.platform],{where:{externalId:{eq:c.externalId}},select:['externalId'],compute:{spend:{sql:'SELECT SUM(spendMicros)/10000.0 FROM self.delivery WHERE date >= $from AND date <= $to',parameters:{from,to}}}}))[0];return Number(value(r.spend)??0);};
const change=async(input,key)=>{for(let attempt=0;attempt<3;attempt++){const r=await graph.actions.changeMedia({input,idempotencyKey:key+':'+attempt});if(r.state==='succeeded')return r;if(r.error?.code==='rejected')return r;}throw Error('change unresolved');};
let answer=null,caveats=[];
if(p.kind==='refuse')return {answer:null,refused:{reason:'The requested data, budget move, shared budget or ended-flight change is outside authority or policy.'},caveats};
if(p.kind==='lookup'){const m=await byName(p.clientCode,p.name);if(m.length!==1)return {answer:null,caveats:[{kind:'not-found',detail:'No exact unambiguous campaign named '+p.name}]};const c=m[0];answer={id:c.externalId,platform:c.platform,status:c.status,budgetMinor:c.budgetMinor,currency:c.accountCurrency,timezone:c.accountTimezone};}
if(p.kind==='client-campaigns')answer=(await campaignsOf(await client(p.clientCode))).filter(c=>c.status==='ACTIVE').map(c=>({id:c.externalId,platform:c.platform}));
if(p.kind==='plan-lines'){const c=await client(p.clientCode);answer=(await rows('PlanLine',{where:{client:{eq:c.rid}},select:['externalId','platformCampaignId']})).filter(r=>r.platformCampaignId===null).map(r=>({id:r.externalId}));}
if(p.kind==='spend'){const c=(await byName(p.clientCode,p.name))[0];answer={id:c.externalId,spendMinor:await spendOf(c,p.from,p.to),currency:c.accountCurrency};const loaded=await loadOf(c.accountExternalId);if(loaded<p.to)caveats.push({kind:'stale-data',detail:'Account loaded through '+loaded});}
if(p.kind==='mixed'){answer=[];for(const [code,name] of [[p.clientCode,p.name],[p.otherClientCode,p.otherName]]){const c=(await byName(code,name))[0];if(!c){caveats.push({kind:'permission',detail:code+' is outside the planner team scope'});continue;}answer.push({id:c.externalId,spendMinor:await spendOf(c,'2026-10-01','2026-10-12'),currency:c.accountCurrency});}}
if(p.kind==='fx'){const c=await client(p.clientCode),totals=new Map();for(const a of await accountsOf(c)){const v=await convertedFor(await dailySpend(types[a.platform],{account:{eq:a.rid}},datesBetween(p.from,p.to)),c.currency);if(v>0)totals.set(channelOf(a.platform),(totals.get(channelOf(a.platform))??0)+v);const loaded=await loadOf(a.externalId);if(loaded<p.to)caveats.push({kind:'stale-data',detail:'Account '+a.externalId+' loaded through '+loaded});}answer=[...totals].map(([channel,spendMinor])=>({channel,spendMinor,currency:c.currency}));}
if(p.kind==='reconcile'){const c=await client(p.clientCode);const all=await rows('VendorInvoice',{where:{client:{eq:c.rid}},select:['externalId','kind','creditFor','campaignId','amountMinor','month']});answer=[];
 for(const i of all){if(i.month!=='2026-09'||i.kind!=='invoice')continue;const net=i.amountMinor+all.filter(x=>x.creditFor===i.externalId).reduce((s,x)=>s+x.amountMinor,0);const campaign=await byExternal(i.campaignId);const delivered=await spendOf(campaign,'2026-09-01','2026-09-30');if(Math.abs(net-delivered)>.02*delivered)answer.push({id:i.externalId,deliveredMinor:delivered,invoicedMinor:net});}}
if(p.kind==='load'){answer=[];for(const a of await accountsOf(await client(p.clientCode))){const loaded=await loadOf(a.externalId);answer.push({accountId:a.externalId,platform:a.platform,loadedThrough:loaded});if(loaded<'2026-10-14')caveats.push({kind:'stale-data',detail:'Account '+a.externalId+' loaded through '+loaded});}}
if(p.kind==='status'||p.kind==='budget'){const c=(await byName(p.clientCode,p.name))[0];const r=await change({platform:c.platform,entity:'campaign',externalId:c.externalId,...(p.kind==='status'?{status:p.status}:{budgetMinor:p.budgetMinor})},'reference-change');if(r.state!=='succeeded')throw Error(JSON.stringify(r));answer=r.output;}
if(p.kind==='create'){
 const c=(await byName(p.clientCode,p.campaignName))[0];const receipt=await graph.actions.launchAdGroup({input:{campaign:c.rid,name:p.name,budgetMinor:p.budgetMinor},idempotencyKey:'reference-launch'});if(receipt.state!=='succeeded')throw Error(JSON.stringify(receipt));const row=await graph.objects.TikTokAdGroup.get(receipt.output.adGroupId,{select:['externalId','name','budgetMinor','campaign']});if(row.status!=='ok')throw Error('Created group not readable');const parent=await graph.objects.TikTokCampaign.get(row.data.campaign,{select:['externalId']});answer={id:row.data.externalId,name:row.data.name,budgetMinor:row.data.budgetMinor,campaignId:parent.data.externalId};
}
if(p.kind==='safety'){const c=await client(p.clientCode);answer=[];const skipped=[];
 for(const a of await accountsOf(c))for(const ad of await rows(adTypes[a.platform],{where:{account:{eq:a.rid}},select:['externalId','highSeverityEvents']})){if(Number(value(ad.highSeverityEvents))<=0)continue;const r=await change({platform:a.platform,entity:'ad',externalId:ad.externalId,status:'PAUSED'},'safety-'+ad.externalId);if(r.state==='succeeded')answer.push({id:ad.externalId});else skipped.push(ad.externalId+' ('+r.error?.details?.reason+')');}
 if(skipped.length)caveats.push({kind:'partial-action',detail:'Not changed: '+skipped.join(', ')});}
if(p.kind==='pacing')answer=(await pacingOf(p.clientCode)).filter(x=>x.pct>110||x.pct<85).map(x=>({id:x.line.externalId,pacingPct:Math.round(x.pct*10)/10,state:x.pct>110?'over':'under'}));
if(p.kind==='rebalance'){const ranked=(await pacingOf(p.clientCode)).filter(x=>x.line.flightEnd>='2026-10-15').sort((a,b)=>b.pct-a.pct);
 for(const x of ranked){if(x.campaign.platform==='google-ads'&&(await rows('GadsCampaign',{where:{budgetId:{eq:x.campaign.budgetId}},select:['externalId']})).length>1)continue;const newBudgetMinor=Math.floor(x.campaign.budgetMinor*0.85);const r=await change({platform:x.campaign.platform,entity:'campaign',externalId:x.campaign.externalId,budgetMinor:newBudgetMinor},'reference-rebalance');if(r.state!=='succeeded')throw Error(JSON.stringify(r));answer={planLineId:x.line.externalId,campaignId:x.campaign.externalId,newBudgetMinor};break;}}
if(p.kind==='dispute'){const invoice=(await rows('VendorInvoice',{where:{externalId:{eq:p.invoiceId}},select:['externalId']}))[0];const r=await graph.actions.recordInvoiceDispute({input:{invoice:invoice.rid,reason:'Delivery reconciliation review',amountMinor:p.amountMinor},idempotencyKey:'reference-dispute'});if(r.state!=='succeeded')throw Error(JSON.stringify(r));answer=r.output;}
return {answer,caveats};
`;

export function referenceCode(task: TaskInstance, arm: Arm) {
  return `const p=${JSON.stringify(parameters(task))};\n${arm === 'relate' ? relateBody : rawPrelude + rawBody}`;
}
