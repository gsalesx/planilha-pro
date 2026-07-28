import JSZip from 'jszip';
import * as XLSX from 'xlsx';
const ID_COL = 0;
const STATUS_COL = 5;
export const FIXED_HEADERS = [
    'ID do pedido',
    'Nome do Produto',
    'Modelo',
    'Qnt.',
    'Nome de usuário',
    'Status',
    'Nome do destinatário',
    ...Array.from({ length: 10 }, (_, i) => `Foto ${i + 1}`),
];
const COLUMN_COUNT = FIXED_HEADERS.length;
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function getElementsByLocalName(element, name) {
    return Array.from(element.querySelectorAll('*')).filter((node) => node.localName === name);
}
function firstChildText(element, name) {
    return getElementsByLocalName(element, name)[0]?.textContent || '';
}
function getRelationshipId(element) {
    return (element.getAttribute('r:id') ||
        element.getAttribute('r:embed') ||
        element.getAttributeNS(NS_R, 'id') ||
        element.getAttributeNS(NS_R, 'embed') ||
        '');
}
function resolveZipPath(fromPart, target) {
    if (target.startsWith('/'))
        return target.slice(1);
    const stack = fromPart.split('/').slice(0, -1);
    for (const part of target.split('/')) {
        if (!part || part === '.')
            continue;
        if (part === '..')
            stack.pop();
        else
            stack.push(part);
    }
    return stack.join('/');
}
function relsPathFor(partPath) {
    const parts = partPath.split('/');
    const file = parts.pop();
    return `${parts.join('/')}/_rels/${file}.rels`;
}
async function readRelationships(zip, partPath) {
    const out = new Map();
    const file = zip.file(relsPathFor(partPath));
    if (!file)
        return out;
    const doc = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
    for (const rel of getElementsByLocalName(doc, 'Relationship')) {
        const id = rel.getAttribute('Id');
        const target = rel.getAttribute('Target');
        if (id && target)
            out.set(id, resolveZipPath(partPath, target));
    }
    return out;
}
function mimeTypeFromPath(p) {
    const ext = p.split('.').pop()?.toLowerCase();
    if (ext === 'png')
        return 'image/png';
    if (ext === 'gif')
        return 'image/gif';
    if (ext === 'webp')
        return 'image/webp';
    return 'image/jpeg';
}
async function getWorksheetPaths(zip) {
    const out = new Map();
    const workbookFile = zip.file('xl/workbook.xml');
    if (!workbookFile)
        return out;
    const rels = await readRelationships(zip, 'xl/workbook.xml');
    const doc = new DOMParser().parseFromString(await workbookFile.async('string'), 'application/xml');
    for (const sheet of getElementsByLocalName(doc, 'sheet')) {
        const name = sheet.getAttribute('name');
        const rid = getRelationshipId(sheet);
        const part = rels.get(rid);
        if (name && part)
            out.set(name, part);
    }
    return out;
}
async function extractImagesBySheet(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const sheetPaths = await getWorksheetPaths(zip);
    const result = new Map();
    for (const [sheetName, worksheetPart] of sheetPaths) {
        const worksheetFile = zip.file(worksheetPart);
        if (!worksheetFile)
            continue;
        const worksheetRels = await readRelationships(zip, worksheetPart);
        const worksheetDoc = new DOMParser().parseFromString(await worksheetFile.async('string'), 'application/xml');
        for (const drawing of getElementsByLocalName(worksheetDoc, 'drawing')) {
            const drawingPart = worksheetRels.get(getRelationshipId(drawing));
            const drawingFile = drawingPart ? zip.file(drawingPart) : null;
            if (!drawingPart || !drawingFile)
                continue;
            const drawingRels = await readRelationships(zip, drawingPart);
            const drawingDoc = new DOMParser().parseFromString(await drawingFile.async('string'), 'application/xml');
            const anchors = [
                ...getElementsByLocalName(drawingDoc, 'twoCellAnchor'),
                ...getElementsByLocalName(drawingDoc, 'oneCellAnchor'),
            ];
            for (const anchor of anchors) {
                const blip = getElementsByLocalName(anchor, 'blip')[0];
                const mediaPath = blip ? drawingRels.get(getRelationshipId(blip)) : null;
                const mediaFile = mediaPath ? zip.file(mediaPath) : null;
                if (!mediaPath || !mediaFile)
                    continue;
                const marker = getElementsByLocalName(anchor, 'from')[0];
                if (!marker)
                    continue;
                const row = Number(firstChildText(marker, 'row'));
                const column = Number(firstChildText(marker, 'col'));
                if (!Number.isFinite(row) || !Number.isFinite(column))
                    continue;
                const blob = await mediaFile.async('blob');
                const list = result.get(sheetName) || [];
                list.push({
                    row,
                    column,
                    blob: new Blob([blob], { type: mimeTypeFromPath(mediaPath) }),
                    fileName: mediaPath.split('/').pop() || 'image.jpg',
                });
                result.set(sheetName, list);
            }
        }
    }
    return result;
}
function normalizeCell(value) {
    if (value == null)
        return null;
    if (typeof value === 'number' || typeof value === 'string')
        return value;
    return String(value);
}
function isDateSheet(name) {
    // Aceita DD-MM-YYYY (formato novo do Zoho Sheets), DD_MM_YYYY ou YYYY_MM_DD (legados).
    return /^\d{2}-\d{2}-\d{4}$/.test(name) || /^\d{2}_\d{2}_\d{4}$/.test(name) || /^\d{4}_\d{2}_\d{2}/.test(name);
}
/** Normaliza o nome da aba pra formato canonico DD-MM-YYYY antes de salvar como sheet_date. */
function normalizeSheetDate(name) {
    let m = /^(\d{4})_(\d{2})_(\d{2})/.exec(name);
    if (m)
        return `${m[3]}-${m[2]}-${m[1]}`;
    m = /^(\d{2})_(\d{2})_(\d{4})$/.exec(name);
    if (m)
        return `${m[1]}-${m[2]}-${m[3]}`;
    return name;
}
function buildHeaderColumnMap(sheetHeaders) {
    const norm = (s) => s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim();
    const target = FIXED_HEADERS.map(norm);
    const map = new Array(COLUMN_COUNT).fill(-1);
    for (let t = 0; t < target.length; t++) {
        for (let s = 0; s < sheetHeaders.length; s++) {
            if (norm(sheetHeaders[s]) === target[t]) {
                map[t] = s;
                break;
            }
        }
    }
    // fallback: positional mapping if header matching missed slots
    for (let t = 0; t < COLUMN_COUNT; t++) {
        if (map[t] === -1)
            map[t] = t;
    }
    return map;
}
function occurrenceKey(sheetDate, id) {
    return `${sheetDate}\u0000${id}`;
}
function matchKey(sheetDate, id, occurrence) {
    return `${occurrenceKey(sheetDate, id)}\u0000${occurrence}`;
}
function nextOccurrence(counts, sheetDate, id) {
    const key = occurrenceKey(sheetDate, id);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
}
function uniqueOrderKey(sheetDate, id, occurrence, used) {
    const base = occurrence === 1
        ? id
        : `${sheetDate || 'sem-data'}__${id || 'pedido'}__${occurrence}`;
    let key = base;
    let suffix = 2;
    while (used.has(key)) {
        key = `${base}__${suffix}`;
        suffix++;
    }
    used.add(key);
    return key;
}
export async function parseXlsx(file, options = {}) {
    const { onProgress, existing } = options;
    onProgress?.('Lendo arquivo...');
    const buffer = await file.arrayBuffer();
    onProgress?.('Lendo abas...');
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    onProgress?.('Extraindo imagens...');
    const imagesBySheet = await extractImagesBySheet(buffer);
    const sheetNames = workbook.SheetNames.filter((name) => isDateSheet(name));
    const allSheetNames = sheetNames.length > 0 ? sheetNames : workbook.SheetNames;
    const newPedidos = [];
    for (const sheetName of allSheetNames) {
        const worksheet = workbook.Sheets[sheetName];
        if (!worksheet || !worksheet['!ref'])
            continue;
        const range = XLSX.utils.decode_range(worksheet['!ref']);
        const sheetHeaders = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
            const cell = worksheet[XLSX.utils.encode_cell({ r: range.s.r, c })];
            sheetHeaders.push(cell ? String(cell.w ?? cell.v ?? '') : '');
        }
        const columnMap = buildHeaderColumnMap(sheetHeaders);
        const sheetImages = imagesBySheet.get(sheetName) ?? [];
        const imagesByBodyRow = new Map();
        for (const img of sheetImages) {
            const bodyRow = img.row - 1;
            if (bodyRow < 0)
                continue;
            const list = imagesByBodyRow.get(bodyRow) ?? [];
            list.push(img);
            imagesByBodyRow.set(bodyRow, list);
        }
        let bodyRowIndex = 0;
        for (let r = range.s.r + 1; r <= range.e.r; r++) {
            const row = new Array(COLUMN_COUNT).fill(null);
            let hasValue = false;
            for (let target = 0; target < COLUMN_COUNT; target++) {
                const source = columnMap[target];
                if (source < 0)
                    continue;
                const cell = worksheet[XLSX.utils.encode_cell({ r, c: range.s.c + source })];
                const value = cell ? normalizeCell(cell.w ?? cell.v) : null;
                if (value != null && value !== '')
                    hasValue = true;
                row[target] = value;
            }
            const id = String(row[ID_COL] ?? '').trim();
            const images = new Map();
            const rawImages = imagesByBodyRow.get(bodyRowIndex) ?? [];
            for (const img of rawImages) {
                const targetCol = columnMap.indexOf(img.column);
                const finalCol = targetCol >= 0 ? targetCol : img.column;
                images.set(finalCol, { blob: img.blob, fileName: img.fileName });
            }
            if (hasValue && id) {
                newPedidos.push({ id, row, sheetDate: normalizeSheetDate(sheetName), occurrence: 0, images });
            }
            bodyRowIndex++;
        }
    }
    const newOccurrences = new Map();
    for (const pedido of newPedidos) {
        pedido.occurrence = nextOccurrence(newOccurrences, pedido.sheetDate, pedido.id);
    }
    // build existing index by data + ID + occurrence
    const existingByMatch = new Map();
    const usedOrderKeys = new Set();
    if (existing && existing.sheetOrder.length > 0) {
        const sheet = existing.sheets[existing.sheetOrder[0]];
        if (sheet) {
            const existingOccurrences = new Map();
            for (let r = 0; r < sheet.rows.length; r++) {
                const id = String(sheet.rows[r]?.[ID_COL] ?? '').trim();
                if (!id)
                    continue;
                const sheetDate = sheet.rowDates?.[r] ?? '';
                const occurrence = nextOccurrence(existingOccurrences, sheetDate, id);
                const orderKey = sheet.rowKeys?.[r] ?? id;
                usedOrderKeys.add(orderKey);
                const styles = new Map();
                for (const [key, val] of Object.entries(sheet.cellStyles ?? {})) {
                    const [rr, cc] = key.split(':').map(Number);
                    if (rr === r)
                        styles.set(cc, val);
                }
                const images = new Map();
                for (const [key, val] of Object.entries(sheet.images)) {
                    const [rr, cc] = key.split(':').map(Number);
                    if (rr === r)
                        images.set(cc, val);
                }
                existingByMatch.set(matchKey(sheetDate, id, occurrence), {
                    key: orderKey,
                    row: sheet.rows[r],
                    sheetDate,
                    styles,
                    images,
                });
            }
        }
    }
    // merge
    const finalRows = [];
    const finalRowKeys = [];
    const finalRowDates = [];
    const finalImages = {};
    const finalStyles = {};
    for (const pedido of newPedidos) {
        const idx = finalRows.length;
        const row = [...pedido.row];
        const prior = existingByMatch.get(matchKey(pedido.sheetDate, pedido.id, pedido.occurrence));
        if (prior) {
            const priorStatus = prior.row[STATUS_COL];
            if (priorStatus != null && priorStatus !== '') {
                row[STATUS_COL] = priorStatus;
            }
            finalRows.push(row);
            finalRowKeys.push(prior.key);
            finalRowDates.push(pedido.sheetDate);
            for (const [col, style] of prior.styles) {
                finalStyles[`${idx}:${col}`] = style;
            }
            for (const [col, img] of prior.images) {
                finalImages[`${idx}:${col}`] = img;
            }
            for (const [col, img] of pedido.images) {
                if (!finalImages[`${idx}:${col}`])
                    finalImages[`${idx}:${col}`] = img;
            }
        }
        else {
            finalRows.push(row);
            finalRowKeys.push(uniqueOrderKey(pedido.sheetDate, pedido.id, pedido.occurrence, usedOrderKeys));
            finalRowDates.push(pedido.sheetDate);
            for (const [col, img] of pedido.images) {
                finalImages[`${idx}:${col}`] = img;
            }
        }
    }
    // compute column widths
    const columnWidths = {};
    for (let c = 0; c < COLUMN_COUNT; c++) {
        let maxLen = FIXED_HEADERS[c].length;
        for (const row of finalRows) {
            const text = row[c] == null ? '' : String(row[c]);
            const longestLine = text.split(/\r?\n/).reduce((m, l) => Math.max(m, l.length), 0);
            if (longestLine > maxLen)
                maxLen = longestLine;
        }
        columnWidths[c] = Math.min(Math.max(maxLen * 7 + 24, 80), 320);
    }
    const sheetId = 'sheet-relatorios';
    const sheet = {
        id: sheetId,
        name: 'Relatórios',
        headers: FIXED_HEADERS,
        rows: finalRows,
        rowKeys: finalRowKeys,
        rowDates: finalRowDates,
        images: finalImages,
        cellStyles: finalStyles,
        columnWidths,
    };
    return {
        id: existing?.id ?? 'workbook-relatorios',
        name: 'Relatórios',
        importedAt: new Date().toISOString(),
        sheetOrder: [sheetId],
        sheets: { [sheetId]: sheet },
    };
}
