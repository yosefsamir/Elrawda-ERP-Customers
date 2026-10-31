"""Inspect disposable ERP copies. Never attach or alter the supplied MDF/LDF files."""
import hashlib, json, os, pathlib, secrets, shutil, subprocess, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'data' / 'database-review'
OUT.mkdir(parents=True, exist_ok=True)
name = 'emoji-schema-review-' + secrets.token_hex(3)
password = secrets.token_urlsafe(28) + 'Aa1!'
work = pathlib.Path(tempfile.mkdtemp(prefix='emoji-sql-review-'))
def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, check=True, **kw).stdout

def digest(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
    return h.hexdigest()
sources={label:[path/f for f in ('alrawda.mdf','alrawda_log.ldf')] for label,path in [('previous',ROOT/'db'),('latest',pathlib.Path('/tmp/emoji-erp-new'))]}
before={label:{p.name:digest(p) for p in paths} for label,paths in sources.items()}
def sql(query):
    # Credentials stay inside this local process; no source credential is used.
    args=['docker','exec',name,'/opt/mssql-tools18/bin/sqlcmd','-C','-S','127.0.0.1,1433','-l','3','-U','sa','-P',password,'-b','-y','0','-w','65535','-Q','SET NOCOUNT ON; '+query]
    proc=subprocess.run(args,capture_output=True,text=True)
    if proc.returncode: raise RuntimeError(proc.stdout+proc.stderr)
    return ''.join(x.strip() for x in proc.stdout.splitlines() if x.strip() and not x.strip().startswith('JSON_') and set(x.strip()) != {'-'})
def query(db,q):
    raw=sql(f'USE [{db}]; '+q+' FOR JSON PATH;')
    return json.loads(raw[raw.index('['):raw.rindex(']')+1]) if '[' in raw else []
try:
    for label,paths in sources.items():
        dest=work/label;dest.mkdir()
        for p in paths:shutil.copy2(p,dest/p.name)
        dest.chmod(0o777)
        for p in dest.iterdir():p.chmod(0o666)
    run(['docker','run','-d','--name',name,'--network','none','--memory','2560m','-e','ACCEPT_EULA=Y','-e','MSSQL_SA_PASSWORD='+password,'-e','MSSQL_MEMORY_LIMIT_MB=1536','mcr.microsoft.com/mssql/server:2022-latest'])
    run(['docker','exec','-u','0',name,'mkdir','-p','/inspection'])
    run(['docker','cp',str(work)+'/.',name+':/inspection/'])
    run(['docker','exec','-u','0',name,'chown','-R','10001:0','/inspection'])
    for attempt in range(60):
        try:sql('SELECT 1;');break
        except RuntimeError as error:
            if attempt==59:raise
            time.sleep(2)
    schemas={}
    for label in sources:
        sql(f"CREATE DATABASE [{label}] ON (FILENAME=N'/inspection/{label}/alrawda.mdf'),(FILENAME=N'/inspection/{label}/alrawda_log.ldf') FOR ATTACH; ALTER DATABASE [{label}] SET READ_ONLY;")
        schemas[label]=query(label,"SELECT s.name AS schemaName,t.name AS tableName,c.name AS columnName,ty.name AS sqlType,c.max_length AS maxLength,c.precision,c.scale,c.is_nullable AS nullable,c.is_identity AS identityColumn FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id ORDER BY s.name,t.name,c.column_id")
        (OUT/(label+'-schema.json')).write_text(json.dumps(schemas[label],ensure_ascii=False,indent=2))
    def key(row):return (row['schemaName'],row['tableName'],row['columnName'])
    old={key(r):r for r in schemas['previous']};new={key(r):r for r in schemas['latest']}
    differences={'addedColumns':[new[k] for k in new.keys()-old.keys()],'removedColumns':[old[k] for k in old.keys()-new.keys()],'changedColumns':[{'before':old[k],'after':new[k]} for k in old.keys()&new.keys() if old[k]!=new[k]]}
    required={'person':['idprogramitems','idbranch','idperson','idkindperson','fperson','ftel1','ftel2','ftel3','ftel4','fhid','fglobal'],'kindperson':['idprogramitems','idbranch','idkindperson','fkindperson'],'branch':['idprogramitems','idbranch','fvis','deleted'],'branchmain':['idbranch','fbranch','fvis','deleted']}
    missing=[f'{table}.{col}' for table,cols in required.items() for col in cols if ('dbo',table,col) not in new]
    # Save private snapshot for local preview/import, never into tracked source.
    customer_query=(ROOT/'scripts/read_customers.sql').read_text()
    start=customer_query.index('SELECT p.')
    select=customer_query[start:].replace('@ProgramItemsId','9').replace('ORDER BY p.idprogramitems, p.idbranch, p.idperson;','ORDER BY p.idprogramitems, p.idbranch, p.idperson')
    customers=query('latest',select)
    branches=query('latest',"SELECT b.idprogramitems,b.idbranch,bm.fbranch,b.fvis,b.deleted FROM dbo.branch b JOIN dbo.branchmain bm ON bm.idbranch=b.idbranch WHERE b.idprogramitems=9 ORDER BY b.idbranch")
    (OUT/'latest-customers.json').write_text(json.dumps(customers,ensure_ascii=False))
    (OUT/'latest-branches.json').write_text(json.dumps(branches,ensure_ascii=False))
    current_hashes={label:{p.name:digest(p) for p in paths} for label,paths in sources.items()}
    report={'date':'2026-10-30','archive':'db/db.rar','comparison':'All user-table column names, types, sizes, nullability, precision, scale, identity','tablesPrevious':len(set(r['tableName'] for r in schemas['previous'])),'tablesLatest':len(set(r['tableName'] for r in schemas['latest'])),'requiredMissing':missing,'compatibleRequiredColumns':not missing,'differences':differences,'latestSelectedCustomerRows':len(customers),'personDateOrVersionColumns':[r for r in schemas['latest'] if r['tableName']=='person' and r['sqlType'] in ['datetime','datetime2','date','smalldatetime','datetimeoffset','timestamp','rowversion']],'sourceFilesUnchanged':before==current_hashes}
    (ROOT/'docs/database-schema-comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='differences'},ensure_ascii=False))
    print('Changes:',{k:len(v) for k,v in differences.items()})
finally:
    subprocess.run(['docker','rm','-f',name],capture_output=True)
    shutil.rmtree(work,ignore_errors=True)
