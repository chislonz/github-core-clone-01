import { Store, Fault } from './store.ts';
// Parse GraphQL selections and values, preserving aliases and variables.
export function parse(query:string, vars:any={}) {
 const tokens=query.match(/\.\.\.|"(?:\\.|[^"\\])*"|\$|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|[^\s,#]/g)||[];let i=0;
 const take=(s:string)=>{if(tokens[i++]!==s)throw Error(`Expected ${s}`);};
 const value=():any=>{const t=tokens[i++];if(t==='$')return vars[tokens[i++]];if(t==='{'){const o:any={};while(tokens[i]!=='}'){const k=tokens[i++];take(':');o[k]=value();}i++;return o;}if(t==='['){const a=[];while(tokens[i]!==']')a.push(value());i++;return a;}if(t?.startsWith('"'))return JSON.parse(t);if(t==='null')return null;if(t==='true'||t==='false')return t==='true';if(/^-?\d/.test(t))return Number(t);return t;};
 const selection=():any[]=>{take('{');const fields=[];while(tokens[i]!=='}'){if(i>=tokens.length)throw Error('Unterminated selection');if(tokens[i]==='...'){i++;take('on');const type=tokens[i++];fields.push({fragment:type,fields:selection()});continue;}let name=tokens[i++],alias=name;if(tokens[i]===':'){i++;name=tokens[i++];}const args:any={};if(tokens[i]==='('){i++;while(tokens[i]!==')'){const k=tokens[i++];take(':');args[k]=value();}i++;}fields.push({name,alias,args,fields:tokens[i]==='{'?selection():[]});}i++;return fields;};
 // Operation variable declarations can contain input defaults with braces.
 if(tokens[0]!=='{'){i++;if(tokens[i]!=='('&&tokens[i]!=='{')i++;if(tokens[i]==='('){let depth=1;i++;while(depth&&i<tokens.length){if(tokens[i]==='(')depth++;if(tokens[i]===')')depth--;i++;}}}
 return selection();
}
const schema:any={User:['login'],Issue:['id','number','title','state','body'],PullRequest:['id','number','title','body','headRefName','baseRefName','mergeable','state','merged','files'],Repository:['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest'],SearchType:['ISSUE','REPOSITORY','USER']};
export function graphql(store:Store,body:any):any {
 if(Array.isArray(body))return body.map(x=>graphql(store,x));
 try {
 const fields=parse(body.query,body.variables);const typed=(type:string,data:any)=>data==null?null:{...data,_type:type};
 const connection=(list:any,a:any)=>{const values=list instanceof Map?[...list.values()]:Array.isArray(list)?list:[];const start=a.after?Number(Buffer.from(a.after,'base64').toString()):0;const end=start+Math.max(0,Math.min(a.first??100,100));const nodes=values.slice(start,end);return{nodes,totalCount:values.length,pageInfo:{hasNextPage:end<values.length,endCursor:nodes.length?Buffer.from(String(start+nodes.length)).toString('base64'):null}};};
 const resolve=(o:any,n:string,a:any):any=>{if(n==='__typename')return o._type;
 if(o._type==='Query'){
 if(n==='viewer')return typed('User',{login:store.owner});
 if(n==='repository'){try{return store.repo(a.owner,a.name);}catch{return null;}}
 if(n==='node')return store.nodes.get(a.id)||null;
 if(n==='__type')return schema[a.name]?{fields:schema[a.name].map((name:string)=>({name})),enumValues:a.name==='SearchType'?schema.SearchType.map((name:string)=>({name})):null}:null;
 const input=a.input||{};if(n==='createIssue'){const r=store.nodes.get(input.repositoryId);if(!r)throw Error('Unknown repository');return{issue:store.issue(r,input)};}
 if(n==='closeIssue'){const x=store.nodes.get(input.issueId);if(!x)throw Error('Unknown issue');x.state='closed';return{issue:x};}
 if(n==='createPullRequest'){const r=store.nodes.get(input.repositoryId);if(!r)throw Error('Unknown repository');return{pullRequest:store.pull(r,{...input,head:input.headRefName,base:input.baseRefName})};}
 if(n==='mergePullRequest'){const p=store.nodes.get(input.pullRequestId);if(!p)throw Error('Unknown pull request');store.merge(p);return{pullRequest:p};}
 if(n==='addComment'){const x=store.nodes.get(input.subjectId);if(!x)throw Error('Unknown subject');const c=store.comment(x,input);return{commentEdge:{node:{id:c.node_id,body:c.body}}};}
 }
 if(o._type==='Repository'){
 if(n==='id')return o.node_id;if(n==='databaseId')return o.id;if(n==='nameWithOwner')return `${store.owner}/${o.name}`;if(n==='owner')return typed('User',{login:store.owner});if(n==='defaultBranchRef')return store.tip(o)?typed('Ref',{name:o.default_branch}):null;if(n==='viewerPermission')return 'ADMIN';if(n==='hasIssuesEnabled')return true;
 if(n==='issue')return o.issues.get(a.number)||null;if(n==='pullRequest')return o.pulls.get(a.number)||null;
 if(n==='issues'||n==='pullRequests'){let list=[...(n==='issues'?o.issues:o.pulls).values()];if(a.states)list=list.filter((x:any)=>a.states.includes(x.state.toUpperCase()));list.sort((x:any,y:any)=>a.orderBy?.direction==='DESC'?y.number-x.number:x.number-y.number);if(n==='pullRequests'){for(const x of list){x._type='PullRequest';x._repo=o;}}if(n==='issues'){for(const x of list)x._type='Issue';}return connection(list,a);}
 }
 if(o._type==='Issue'||o._type==='PullRequest'){if(n==='id')return o.node_id;if(n==='state')return o.merged?'MERGED':o.state.toUpperCase();if(n==='headRefName')return o.head.ref;if(n==='baseRefName')return o.base.ref;if(n==='mergeable')return 'MERGEABLE';if(n==='files')return connection(store.files(o),a);}
 if(Object.hasOwn(o,n))return o[n];throw Error(`Unknown field ${n} on ${o._type||'object'}`);
 };
 const project=(o:any,fs:any[]):any=>{if(o==null)return null;if(Array.isArray(o))return o.map(x=>project(x,fs));const out:any={};for(const f of fs){if(f.fragment){if(o._type===f.fragment)Object.assign(out,project(o,f.fields));continue;}const val=resolve(o,f.name,f.args);out[f.alias]=f.fields.length?project(val,f.fields):val;}return out;};
 return{data:project({_type:'Query'},fields)};
 }catch(e){return{errors:[{message:(e as Error).message}]};}
}
