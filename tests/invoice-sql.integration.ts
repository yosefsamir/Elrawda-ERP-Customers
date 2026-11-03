import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import sql from 'mssql';
import {readSqlInvoices} from '../packages/erp/invoices.js';
import type {SqlConfig} from '../packages/erp/source.js';

test('real SQL Server: bounded pages, timestamp ties, numeric keys, recent updates and late lower codes', {skip:!process.env.ELRAWDA_SQL_PAGINATION_CONFIG}, async()=>{
  const config:SqlConfig=JSON.parse(readFileSync(process.env.ELRAWDA_SQL_PAGINATION_CONFIG!,'utf8'));
  const db=await new sql.ConnectionPool({server:config.server,database:config.database,user:config.user,password:config.password,options:{encrypt:true,trustServerCertificate:true}}).connect();
  try {
    await db.request().query(`CREATE TABLE dbo.invo_s(
      idprogramitems bigint NOT NULL,idbranch bigint NOT NULL,idno_s bigint NOT NULL,idperson bigint NOT NULL,
      fno_i bigint,dateentry datetime,fdate datetime,fprinted int,deleted bit,
      CONSTRAINT PK_invoice_qa PRIMARY KEY(idprogramitems,idbranch,idno_s));
      WITH n AS(SELECT TOP (12000) ROW_NUMBER() OVER(ORDER BY (SELECT NULL)) n FROM sys.all_objects a CROSS JOIN sys.all_objects b)
      INSERT dbo.invo_s SELECT 9,39,n,n,n,DATEADD(second,n,'20261001'),NULL,0,0 FROM n;
      WITH n AS(SELECT TOP (125) ROW_NUMBER() OVER(ORDER BY (SELECT NULL)) n FROM sys.all_objects a CROSS JOIN sys.all_objects b)
      INSERT dbo.invo_s SELECT 9,CASE WHEN n<=65 THEN 39 ELSE 40 END,9007199254740993+n,n,n,'20261103 09:00:00.003',NULL,0,0 FROM n;`);
    let cursor={enteredAt:'2026-11-03T09:00:00.000',branchId:0,invoiceId:'0'};
    const seen=new Set<string>();
    for(const expected of [50,50,25,0]) {
      const page=await readSqlInvoices(config,{kind:'after',cursor,limit:50,through:'2026-11-03T12:00:00.000'});
      assert.equal(page.invoices.length,expected);page.invoices.forEach(i=>seen.add(`${i.idbranch}:${i.idno_s}`));
      if(page.cursor)cursor=page.cursor;
    }
    assert.equal(seen.size,125);assert.equal(cursor.enteredAt,'2026-11-03T09:00:00.003');
    await db.request().query("UPDATE dbo.invo_s SET fprinted=2,deleted=1 WHERE idbranch=40 AND idno_s=9007199254741118; INSERT dbo.invo_s VALUES(9,40,1,1,1,'20261103 10:00:00',NULL,0,0);");
    const next=await readSqlInvoices(config,{kind:'after',cursor,limit:50,through:'2026-11-03T12:00:00.000'});
    assert.equal(next.invoices.length,1);assert.equal(next.invoices[0].idno_s,'1');
    const recent=await readSqlInvoices(config,{kind:'recent',limit:49,through:'2026-11-03T12:00:00.000'});
    assert.equal(recent.invoices.length,49);const changed=recent.invoices.find(i=>i.idno_s==='9007199254741118');assert.equal(changed?.fprinted,2);assert.equal(changed?.deleted,true);
    await assert.rejects(readSqlInvoices(config,{kind:'recent',limit:51,through:'2026-11-03T12:00:00.000'}),/limit/);
  } finally {await db.close();}
});
