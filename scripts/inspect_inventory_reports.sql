/* Read-only inventory evidence export, NOT approved stock balances.
   Run all SELECTs against one stable restored ERP copy, not a changing live source.
   Includes no customer/contact fields and executes no stored procedures.
   Recordsets: coverage, raw movements, product labels, branch labels, store labels,
   and counts of additional sources which must be empty for this limited probe.
   Manufacturing dates/direction, opening semantics and unit conversion need review.
   Do not derive movement direction from fefect or fbkg: their meaning is unconfirmed.
   @until is exclusive; no lower cutoff because opening needs prior history.
   The export uses raw ERP wall-clock date strings, without UTC conversion. */
SET NOCOUNT ON;
SET LOCK_TIMEOUT 5000;
DECLARE @program bigint=9, @until datetime='20261028';

SELECT 'gard' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.gard d LEFT JOIN dbo.invo_gard h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'ward' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.ward d LEFT JOIN dbo.invo_w h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'sadr' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.sadr d LEFT JOIN dbo.invo_s h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'return_s' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.return_s d LEFT JOIN dbo.invo_return_s h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'return_w' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.return_w d LEFT JOIN dbo.invo_return_w h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'sarf_s' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.sarf_s d LEFT JOIN dbo.invo_sarf_s h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'sarf_w' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.sarf_w d LEFT JOIN dbo.invo_sarf_w h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'trans' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.trans d LEFT JOIN dbo.invo_trans h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'transstorbranch' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.transstorbranch d LEFT JOIN dbo.invo_transstorbranch h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'manf' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.manf d LEFT JOIN dbo.invo_manf h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program
UNION ALL
SELECT 'costitemsmanf' source,COUNT_BIG(*) all_lines,CONVERT(varchar(23),@until,121) export_until,
 SUM(CASE WHEN h.idno_s IS NULL THEN 1 ELSE 0 END) missing_headers,
 SUM(CASE WHEN d.deleted=0 AND h.deleted=0 THEN 1 ELSE 0 END) active_lines,
 SUM(CASE WHEN d.deleted IS NULL OR h.deleted IS NULL THEN 1 ELSE 0 END) null_deletion_flags
FROM dbo.costitemsmanf d LEFT JOIN dbo.invo_manf h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program;

SELECT 'gard' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.idgard line_id,
 d.iddet,d.idunit,d.fquntity quantity,d.fbouns bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),h.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 NULL destination_branch,NULL destination_store,
 NULL destination_product,NULL destination_quantity,
 NULL changes_product,NULL component_direction,NULL consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.gard d JOIN dbo.invo_gard h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND h.fdate<@until
UNION ALL
SELECT 'ward' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.idward line_id,
 d.iddet,d.idunit,d.fquntity quantity,d.fbouns bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),h.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 NULL destination_branch,NULL destination_store,
 NULL destination_product,NULL destination_quantity,
 NULL changes_product,NULL component_direction,NULL consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.ward d JOIN dbo.invo_w h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND h.fdate<@until
UNION ALL
SELECT 'sadr' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.idsadr line_id,
 d.iddet,d.idunit,d.fquntity quantity,d.fbouns bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),h.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 NULL destination_branch,NULL destination_store,
 NULL destination_product,NULL destination_quantity,
 NULL changes_product,NULL component_direction,NULL consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.sadr d JOIN dbo.invo_s h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND h.fdate<@until
UNION ALL
SELECT 'return_s' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.idreturn_s line_id,
 d.iddet,d.idunit,d.fquntity quantity,d.fbouns bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),h.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 NULL destination_branch,NULL destination_store,
 NULL destination_product,NULL destination_quantity,
 NULL changes_product,NULL component_direction,NULL consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.return_s d JOIN dbo.invo_return_s h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND h.fdate<@until
UNION ALL
SELECT 'return_w' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.idreturn_w line_id,
 d.iddet,d.idunit,d.fquntity quantity,d.fbouns bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),h.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 NULL destination_branch,NULL destination_store,
 NULL destination_product,NULL destination_quantity,
 NULL changes_product,NULL component_direction,NULL consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.return_w d JOIN dbo.invo_return_w h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND h.fdate<@until
UNION ALL
SELECT 'sarf_s' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.idsarf_s line_id,
 d.iddet,d.idunit,d.fquntity quantity,d.fbouns bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),h.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 NULL destination_branch,NULL destination_store,
 NULL destination_product,NULL destination_quantity,
 NULL changes_product,NULL component_direction,h.famana consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.sarf_s d JOIN dbo.invo_sarf_s h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND h.fdate<@until
UNION ALL
SELECT 'sarf_w' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.idsarf_w line_id,
 d.iddet,d.idunit,d.fquntity quantity,d.fbouns bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),h.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 NULL destination_branch,NULL destination_store,
 NULL destination_product,NULL destination_quantity,
 NULL changes_product,NULL component_direction,h.famana consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.sarf_w d JOIN dbo.invo_sarf_w h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND h.fdate<@until
UNION ALL
SELECT 'trans' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.idtrans line_id,
 d.iddet,d.idunit,d.fquntity quantity,d.fbouns bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),h.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 d.idbranch destination_branch,d.idstortrans destination_store,
 d.iddettrans destination_product,d.fquntitytrans destination_quantity,
 h.ftranssanftosanf changes_product,NULL component_direction,NULL consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.trans d JOIN dbo.invo_trans h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND h.fdate<@until
UNION ALL
SELECT 'transstorbranch' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.idtransstorbranch line_id,
 d.iddet,d.idunit,d.fquntity quantity,d.fbouns bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),h.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 d.idbranchtrans destination_branch,d.idstortrans destination_store,
 NULL destination_product,NULL destination_quantity,
 NULL changes_product,NULL component_direction,NULL consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.transstorbranch d JOIN dbo.invo_transstorbranch h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND h.fdate<@until
UNION ALL
SELECT 'manf' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.idmanf line_id,
 d.iddet,d.idunit,d.fquntity quantity,d.fbouns bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),h.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 NULL destination_branch,NULL destination_store,
 NULL destination_product,NULL destination_quantity,
 NULL changes_product,NULL component_direction,NULL consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.manf d JOIN dbo.invo_manf h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND h.fdate<@until
UNION ALL
SELECT 'costitemsmanf' source,d.idprogramitems,d.idbranch,d.idstor,d.idno_s,d.id line_id,
 d.iddet,d.idunit,d.fquntity quantity,0 bonus,d.fbkg quantity_hint,
 d.fbkgun2 unit_factor2,d.fbkgun3 unit_factor3,
 CONVERT(varchar(23),d.fdate,121) movement_date,
 CONVERT(varchar(23),h.fdate,121) header_date,
 CONVERT(varchar(23),d.dateentry,121) entry_date,
 CONVERT(varchar(23),h.fcoststepsdateclosed,121) manufacturing_closed_date,
 NULL destination_branch,NULL destination_store,
 NULL destination_product,NULL destination_quantity,
 NULL changes_product,d.faddorminus component_direction,NULL consignment_flag,
 d.firstked detail_firstked,h.firstked header_firstked
FROM dbo.costitemsmanf d JOIN dbo.invo_manf h
 ON h.idprogramitems=d.idprogramitems AND h.idbranch=d.idbranch AND h.idno_s=d.idno_s
WHERE d.idprogramitems=@program AND d.deleted=0 AND h.deleted=0
 AND d.fdate<@until;

SELECT d.iddet,f.ffarz code,n.fname section,c.fcolor classification,s.fsize size,
 k.fkind item_type,d.fservice service_item
FROM dbo.maindet d
JOIN dbo.mainfarz f ON f.idfarz=d.idfarz
JOIN dbo.mainsize s ON s.idsize=f.idsize
JOIN dbo.maincolor c ON c.idcolor=s.idcolor
JOIN dbo.main n ON n.idname=c.idname
JOIN dbo.kind k ON k.idkind=n.idkind AND k.idprogramitems=@program;

SELECT b.idbranch,bm.fbranch branch_name
FROM dbo.branch b JOIN dbo.branchmain bm ON bm.idbranch=b.idbranch
WHERE b.idprogramitems=@program;

SELECT idbranch,idstor,fstor store_name FROM dbo.stor WHERE idprogramitems=@program;

SELECT 'itemssadr' source,COUNT_BIG(*) all_lines FROM dbo.itemssadr WHERE idprogramitems=@program
UNION ALL
SELECT 'itemssarf_w' source,COUNT_BIG(*) all_lines FROM dbo.itemssarf_w WHERE idprogramitems=@program
UNION ALL
SELECT 'restsadr' source,COUNT_BIG(*) all_lines FROM dbo.restsadr WHERE idprogramitems=@program
UNION ALL
SELECT 'restitemssadr' source,COUNT_BIG(*) all_lines FROM dbo.restitemssadr WHERE idprogramitems=@program
UNION ALL
SELECT 'manfforms' source,COUNT_BIG(*) all_lines FROM dbo.manfforms WHERE idprogramitems=@program
UNION ALL
SELECT 'costitemsward' source,COUNT_BIG(*) all_lines FROM dbo.costitemsward WHERE idprogramitems=@program
UNION ALL
SELECT 'costitemstrans' source,COUNT_BIG(*) all_lines FROM dbo.costitemstrans WHERE idprogramitems=@program
UNION ALL
SELECT 'costitemssarf_w' source,COUNT_BIG(*) all_lines FROM dbo.costitemssarf_w WHERE idprogramitems=@program
UNION ALL
SELECT 'costitemsmanfforms',COUNT_BIG(*) FROM dbo.costitemsmanfforms WHERE idprogramitems=@program
UNION ALL
SELECT 'devcostitem',COUNT_BIG(*) FROM dbo.devcostitem WHERE idprogramitems=@program
UNION ALL
SELECT 'mainitem',COUNT_BIG(*) FROM dbo.mainitem WHERE idprogramitems=@program
UNION ALL
SELECT 'restshow',COUNT_BIG(*) FROM dbo.restshow WHERE idprogramitems=@program
UNION ALL
SELECT 'show_s',COUNT_BIG(*) FROM dbo.show_s WHERE idprogramitems=@program
UNION ALL
SELECT 'show_w',COUNT_BIG(*) FROM dbo.show_w WHERE idprogramitems=@program;
