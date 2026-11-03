/**
 * @file pdf-engine.js
 * @description pdf-lib および @pdf-lib/fontkit を用いたPDF解析・結合・分割・空白頁生成・左右回転・ダイレクト文字編集・通しページ番号描画・複数フォント埋め込みエンジン
 */

/**
 * 標準用紙サイズ定義（単位: PDFポイント = 1/72 inch）
 */
export const PAPER_SIZES = {
  'a4-portrait': { width: 595.28, height: 841.89, label: 'A4 縦' },
  'a4-landscape': { width: 841.89, height: 595.28, label: 'A4 横' }
};

/**
 * フォントカタログ定義
 * ページ番号およびテキスト編集で利用可能なフォント種別（MS明朝・游明朝・Century・ゴシック等）
 */
export const FONT_CATALOG = {
  'ms-mincho': {
    label: 'MS 明朝',
    cssFamily: '"MS Mincho", "ＭＳ 明朝", "BIZ UDMincho", "Noto Serif JP", serif',
    category: 'serif-cjk',
    ttfUrls: [
      'https://fonts.gstatic.com/s/bizudmincho/v11/EJRRQgI6eOxFjBdKs38yhtW1dw.ttf',
      'https://fonts.gstatic.com/s/notoserifjp/v34/xn71YHs72GKoTvER4Gn3b5eMRtWGkp6o7MjQ2bwxOubA.ttf'
    ]
  },
  'yu-mincho': {
    label: '游明朝',
    cssFamily: '"Yu Mincho", "游明朝", "YuMincho", "Noto Serif JP", "BIZ UDMincho", serif',
    category: 'serif-cjk',
    ttfUrls: [
      'https://fonts.gstatic.com/s/notoserifjp/v34/xn71YHs72GKoTvER4Gn3b5eMRtWGkp6o7MjQ2bwxOubA.ttf',
      'https://fonts.gstatic.com/s/bizudmincho/v11/EJRRQgI6eOxFjBdKs38yhtW1dw.ttf'
    ]
  },
  'noto-serif': {
    label: 'Noto Serif JP (明朝)',
    cssFamily: '"Noto Serif JP", "Yu Mincho", "游明朝", serif',
    category: 'serif-cjk',
    ttfUrls: [
      'https://fonts.gstatic.com/s/notoserifjp/v34/xn71YHs72GKoTvER4Gn3b5eMRtWGkp6o7MjQ2bwxOubA.ttf',
      'https://fonts.gstatic.com/s/bizudmincho/v11/EJRRQgI6eOxFjBdKs38yhtW1dw.ttf'
    ]
  },
  century: {
    label: 'Century (センチュリー)',
    cssFamily: 'Century, "Century Schoolbook", "Libre Baskerville", "Times New Roman", "Yu Mincho", serif',
    category: 'serif-latin',
    standardFallback: 'TimesRoman',
    cjkFallbackKey: 'yu-mincho',
    ttfUrls: [
      'https://fonts.gstatic.com/s/librebaskerville/v24/kmKUZrc3Hgbbcjq75U4uslyuy4kn0olVQ-LglH6T17uj8Q4SCQ.ttf'
    ]
  },
  times: {
    label: 'Times New Roman',
    cssFamily: '"Times New Roman", Times, "Yu Mincho", serif',
    category: 'serif-latin',
    standardFont: 'TimesRoman',
    cjkFallbackKey: 'yu-mincho',
    ttfUrls: []
  },
  'yu-gothic': {
    label: '游ゴシック',
    cssFamily: '"Yu Gothic", "游ゴシック", "YuGothic", "Noto Sans JP", sans-serif',
    category: 'sans-cjk',
    ttfUrls: [
      'https://fonts.gstatic.com/s/notosansjp/v52/-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFBEj75s.ttf',
      'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf'
    ]
  },
  'ms-gothic': {
    label: 'MS ゴシック',
    cssFamily: '"MS Gothic", "ＭＳ ゴシック", "BIZ UDGothic", "Noto Sans JP", sans-serif',
    category: 'sans-cjk',
    ttfUrls: [
      'https://fonts.gstatic.com/s/bizudgothic/v12/daafSTouBF7RUjnbt8p3LuKttQ.ttf',
      'https://fonts.gstatic.com/s/notosansjp/v52/-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFBEj75s.ttf'
    ]
  },
  'noto-sans': {
    label: 'Noto Sans JP (ゴシック)',
    cssFamily: '"Noto Sans JP", "Inter", sans-serif',
    category: 'sans-cjk',
    ttfUrls: [
      'https://fonts.gstatic.com/s/notosansjp/v52/-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFBEj75s.ttf',
      'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf'
    ]
  },
  helvetica: {
    label: 'Helvetica / Arial',
    cssFamily: 'Helvetica, Arial, "Noto Sans JP", sans-serif',
    category: 'sans-latin',
    standardFont: 'Helvetica',
    cjkFallbackKey: 'noto-sans',
    ttfUrls: []
  }
};

/**
 * フォントキーから CSS font-family 文字列を取得する
 * @param {string} [fontKey='noto-sans'] - フォント識別キー
 * @returns {string} CSS font-family
 */
export function getCssFontFamily(fontKey = 'noto-sans') {
  const entry = FONT_CATALOG[fontKey] || FONT_CATALOG['noto-sans'];
  return entry.cssFamily;
}

/**
 * URLごとのフォントバイナリキャッシュ
 * @type {Map<string, Uint8Array>}
 */
const fontBytesCache = new Map();

/**
 * URLごとの進行中ダウンロードプロミス
 * @type {Map<string, Promise<Uint8Array>>}
 */
const fontFetchPromises = new Map();

/**
 * 指定URLからフォントバイナリを取得してキャッシュする
 * @param {string} url - フォントURL
 * @returns {Promise<Uint8Array>}
 */
async function fetchFontBytesFromUrl(url) {
  if (fontBytesCache.has(url)) {
    return fontBytesCache.get(url);
  }
  if (fontFetchPromises.has(url)) {
    return fontFetchPromises.get(url);
  }

  const promise = (async () => {
    try {
      const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
      if (!response.ok) {
        throw new Error(`HTTPステータスエラー: ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      fontBytesCache.set(url, bytes);
      return bytes;
    } finally {
      fontFetchPromises.delete(url);
    }
  })();

  fontFetchPromises.set(url, promise);
  return promise;
}

/**
 * 指定されたフォントキーのTTF/OTFバイナリを取得する
 * @param {string} [fontKey='noto-sans'] - フォントキー
 * @returns {Promise<Uint8Array | null>}
 */
export async function loadFontBytesByKey(fontKey = 'noto-sans') {
  const entry = FONT_CATALOG[fontKey] || FONT_CATALOG['noto-sans'];
  if (!entry.ttfUrls || entry.ttfUrls.length === 0) {
    return null;
  }

  let lastError = null;
  for (const url of entry.ttfUrls) {
    try {
      return await fetchFontBytesFromUrl(url);
    } catch (error) {
      console.warn(`フォント取得失敗 (${fontKey}: ${url}):`, error);
      lastError = error;
    }
  }
  throw new Error(
    `フォント (${entry.label}) のダウンロードに失敗しました。(${
      lastError ? lastError.message : 'ネットワークエラー'
    })`
  );
}

/**
 * 日本語フォント（デフォルトのゴシック体または指定フォント）を事前プリロードする
 * @param {string} [fontKey='noto-sans'] - プリロードするフォントキー
 * @returns {Promise<Uint8Array | null>}
 */
export async function preloadJapaneseFont(fontKey = 'noto-sans') {
  return loadFontBytesByKey(fontKey);
}

/**
 * 文字列に非ASCII文字（日本語など）が含まれているか判定する
 * @param {string} text - 判定する文字列
 * @returns {boolean}
 */
function containsNonAscii(text) {
  return /[^\x00-\x7F]/.test(String(text || ''));
}

/**
 * 出力先の PDFDocument に対して、指定された fontKey と描画テキストに最適なフォントを埋め込んで返す
 * 同一ドキュメント内ではキャッシュ再利用し、重複埋め込みを防止する
 *
 * @param {object} outputPdf - pdf-lib の PDFDocument インスタンス
 * @param {string} fontKey - 選択されたフォントキー
 * @param {string} sampleText - 描画予定の文字列（非ASCII判定用）
 * @param {Map<string, object>} docFontCache - ドキュメント単位の埋め込み済み PDFFont マップ
 * @returns {Promise<object>} 埋め込まれた PDFFont インスタンス
 */
async function resolveEmbeddedFontForPdf(
  outputPdf,
  fontKey,
  sampleText,
  docFontCache
) {
  const { StandardFonts } = window.PDFLib;
  let effectiveKey = FONT_CATALOG[fontKey] ? fontKey : 'noto-sans';
  const entry = FONT_CATALOG[effectiveKey];

  // 欧文専用フォント (century, times, helvetica) が選択されているが、テキストに日本語が含まれる場合は対応する明朝/ゴシックへフォールバック
  if (entry.cjkFallbackKey && containsNonAscii(sampleText)) {
    effectiveKey = entry.cjkFallbackKey;
  }

  if (docFontCache.has(effectiveKey)) {
    return docFontCache.get(effectiveKey);
  }

  const targetEntry = FONT_CATALOG[effectiveKey] || FONT_CATALOG['noto-sans'];

  // PDF標準フォント (TimesRoman / Helvetica) が指定されている場合
  if (targetEntry.standardFont && StandardFonts[targetEntry.standardFont]) {
    const stdFont = await outputPdf.embedFont(
      StandardFonts[targetEntry.standardFont]
    );
    docFontCache.set(effectiveKey, stdFont);
    return stdFont;
  }

  // TTF/OTF フォントを fontkit 経由で埋め込む
  if (window.fontkit && targetEntry.ttfUrls && targetEntry.ttfUrls.length > 0) {
    try {
      outputPdf.registerFontkit(window.fontkit);
      const fontBytes = await loadFontBytesByKey(effectiveKey);
      if (fontBytes) {
        const customFont = await outputPdf.embedFont(fontBytes);
        docFontCache.set(effectiveKey, customFont);
        return customFont;
      }
    } catch (error) {
      console.warn(
        `カスタムフォント (${effectiveKey}) の埋め込みに失敗したため標準フォントへフォールバックします:`,
        error
      );
    }
  }

  // フォールバック（Century 等なら TimesRoman、それ以外は Helvetica）
  const fallbackStdName = targetEntry.standardFallback || 'Helvetica';
  const fallbackFont = await outputPdf.embedFont(
    StandardFonts[fallbackStdName] || StandardFonts.Helvetica
  );
  docFontCache.set(effectiveKey, fallbackFont);
  return fallbackFont;
}

/**
 * 回転角度を常に 0, 90, 180, 270 のいずれかに正規化する
 * @param {number} angle - 任意の回転角度
 * @returns {number} 正規化された角度 (0 | 90 | 180 | 270)
 */
export function normalizeRotation(angle) {
  const num = Number(angle) || 0;
  return (((Math.round(num / 90) * 90) % 360) + 360) % 360;
}

/**
 * PDFバイナリを検証し、総ページ数・各ページの初期回転角度・各ページの基準サイズを取得する
 * @param {Uint8Array} pdfBytes - PDFファイルのバイト配列
 * @returns {Promise<{ pageCount: number, pageRotations: number[], pageSizes: Array<{ width: number, height: number }> }>}
 */
export async function inspectPdfDocument(pdfBytes) {
  const { PDFDocument } = window.PDFLib;
  if (!PDFDocument) {
    throw new Error('pdf-lib ライブラリが読み込まれていません。');
  }

  try {
    const pdfDoc = await PDFDocument.load(pdfBytes.slice(0), {
      ignoreEncryption: true,
      updateMetadata: false
    });

    const pageCount = pdfDoc.getPageCount();
    if (pageCount === 0) {
      throw new Error('ページが含まれていないPDFファイルです。');
    }

    const pages = pdfDoc.getPages();
    const pageRotations = [];
    const pageSizes = [];

    for (const page of pages) {
      const angle = normalizeRotation(page.getRotation().angle || 0);
      pageRotations.push(angle);
      const box = page.getCropBox() || page.getMediaBox();
      pageSizes.push({
        width: box.width || 595.28,
        height: box.height || 841.89
      });
    }

    return { pageCount, pageRotations, pageSizes };
  } catch (error) {
    throw new Error(
      `PDFファイルの解析に失敗しました。破損しているかパスワード保護されている可能性があります。(${error.message})`
    );
  }
}

/**
 * ページ要素の現在の視覚的表示サイズ（回転適用後の幅・高さ）を取得する
 * @param {object} pageItem - ページ要素
 * @returns {{ width: number, height: number }}
 */
export function getEffectivePageDimensions(pageItem) {
  const rawW = Number(pageItem?.width) || 595.28;
  const rawH = Number(pageItem?.height) || 841.89;
  const totalRot = normalizeRotation(
    (pageItem?.originalRotation || 0) + (pageItem?.rotation || 0)
  );
  if (totalRot === 90 || totalRot === 270) {
    return { width: rawH, height: rawW };
  }
  return { width: rawW, height: rawH };
}

/**
 * 通しページ番号の書式に従って表示文字列を生成する
 * @param {'simple' | 'hyphen' | 'p-dot' | 'page-en' | 'fraction'} format - 書式種別
 * @param {number} pageNumber - 現在のページ番号
 * @param {number} totalPages - 総ページ数
 * @returns {string} フォーマットされたページ番号文字列
 */
export function formatPageNumberString(format, pageNumber, totalPages) {
  switch (format) {
    case 'simple':
      return `${pageNumber}`;
    case 'hyphen':
      return `- ${pageNumber} -`;
    case 'p-dot':
      return `P.${pageNumber}`;
    case 'page-en':
      return `Page ${pageNumber}`;
    case 'fraction':
      return `${pageNumber} / ${totalPages}`;
    default:
      return `${pageNumber}`;
  }
}

/**
 * ページリスト全体に対して、開始ページ・番号飛ばし（スキップ）・印字のみ非表示を考慮した
 * 通しページ番号情報を一括計算する
 *
 * @param {Array<object>} pageList - 全ページ状態の配列
 * @param {object} globalConfig - 一括ページ番号設定 ({ enabled, format, fontFamily, fontSizePt, startPage, startNumber, position })
 * @returns {Array<{
 *   visible: boolean,
 *   isExplicitHidden: boolean,
 *   hiddenReason: 'skip' | 'before-start' | 'count-only' | null,
 *   assignedNumber: number | null,
 *   position: string,
 *   text: string,
 *   fontFamily: string,
 *   fontSizePt: number
 * }>}
 */
export function computePageNumbersForAllPages(pageList, globalConfig) {
  if (!Array.isArray(pageList) || pageList.length === 0) {
    return [];
  }

  const enabled = Boolean(globalConfig?.enabled);
  const startPage = Math.max(1, Number(globalConfig?.startPage) || 1);
  const startNum = Math.max(1, Number(globalConfig?.startNumber) || 1);
  const format = globalConfig?.format || 'hyphen';
  const defaultPos = globalConfig?.position || 'bottom-center';
  const fontFamily = globalConfig?.fontFamily || 'yu-mincho';
  const fontSizePt = Math.max(
    6,
    Math.min(36, Number(globalConfig?.fontSizePt) || 10.5)
  );

  // 第1パス：各ページがカウント対象かどうかを判定し、通し番号を割り当てる
  let countedCount = 0;
  const intermediate = pageList.map((pageItem, idx) => {
    const pageOrderOneBased = idx + 1;
    const override = pageItem?.pageNumberOverride || 'inherit';

    // 1. 個別設定で「番号を飛ばす / 非表示 (hidden / skip)」が指定されている場合 -> カウントを進めない
    if (override === 'hidden' || override === 'skip') {
      return {
        isCounted: false,
        shouldPrint: false,
        hiddenReason: 'skip',
        assignedNumber: null,
        position: defaultPos
      };
    }

    // 2. 個別設定で「印字のみ隠す (count-only)」が指定されている場合 -> カウントは進めるが印字しない
    if (override === 'count-only') {
      const assignedNumber = startNum + countedCount;
      countedCount += 1;
      return {
        isCounted: true,
        shouldPrint: false,
        hiddenReason: 'count-only',
        assignedNumber,
        position: defaultPos
      };
    }

    // 3. 個別設定で特定の表示位置が指定されている場合 -> 開始ページ前でも強制的にカウント＆表示
    if (override !== 'inherit') {
      const assignedNumber = startNum + countedCount;
      countedCount += 1;
      return {
        isCounted: true,
        shouldPrint: true,
        hiddenReason: null,
        assignedNumber,
        position: override
      };
    }

    // 4. 一括設定に従う (inherit) 場合：開始ページ (startPage) より前のページはカウントせず非表示
    if (pageOrderOneBased < startPage) {
      return {
        isCounted: false,
        shouldPrint: false,
        hiddenReason: 'before-start',
        assignedNumber: null,
        position: defaultPos
      };
    }

    // 開始ページ以降の通常ページ -> カウントして表示
    const assignedNumber = startNum + countedCount;
    countedCount += 1;
    return {
      isCounted: true,
      shouldPrint: true,
      hiddenReason: null,
      assignedNumber,
      position: defaultPos
    };
  });

  // 「1 / 総ページ数」における最終ページ番号（分母）
  const maxPageNumber =
    countedCount > 0 ? startNum + countedCount - 1 : startNum;

  // 第2パス：フォーマット文字列を確定させる
  return intermediate.map((info) => {
    if (!info.isCounted || info.assignedNumber === null) {
      return {
        visible: false,
        isExplicitHidden: true,
        hiddenReason: info.hiddenReason,
        assignedNumber: null,
        position: info.position,
        text: '',
        fontFamily,
        fontSizePt
      };
    }

    const formattedText = formatPageNumberString(
      format,
      info.assignedNumber,
      maxPageNumber
    );

    if (!info.shouldPrint) {
      return {
        visible: false,
        isExplicitHidden: true,
        hiddenReason: info.hiddenReason,
        assignedNumber: info.assignedNumber,
        position: info.position,
        text: formattedText,
        fontFamily,
        fontSizePt
      };
    }

    return {
      visible: enabled,
      isExplicitHidden: false,
      hiddenReason: null,
      assignedNumber: info.assignedNumber,
      position: info.position,
      text: formattedText,
      fontFamily,
      fontSizePt
    };
  });
}

/**
 * 各ページに対するページ番号の表示有無・表示位置・フォント・サイズ・印字テキストを解決する
 * @param {object} pageItem - ページ状態オブジェクト
 * @param {object} globalConfig - 一括ページ番号設定
 * @param {number} orderIndex - 0始まりのページ並び順インデックス
 * @param {number} totalPages - 全体の総ページ数
 * @param {Array<object>} [allPageList] - 全ページ配列（スキップ計算用）
 */
export function resolvePageNumberForPage(
  pageItem,
  globalConfig,
  orderIndex,
  totalPages,
  allPageList
) {
  if (Array.isArray(allPageList) && allPageList.length > 0) {
    const computedList = computePageNumbersForAllPages(
      allPageList,
      globalConfig
    );
    if (computedList[orderIndex]) {
      return computedList[orderIndex];
    }
  }

  // 単体フォールバック
  const singleList = computePageNumbersForAllPages([pageItem], {
    ...globalConfig,
    startPage: 1
  });
  return singleList[0];
}

/**
 * 16進数カラーコード（例: "#dc2626"）を pdf-lib の rgb() オブジェクトに変換する
 * @param {string} hexColor - 16進数カラー文字列
 * @returns {object} pdf-lib の RGB カラーオブジェクト
 */
function hexToPdfRgb(hexColor) {
  const { rgb } = window.PDFLib;
  const cleaned = (hexColor || '#000000').replace('#', '').trim();
  if (cleaned.length !== 6) {
    return rgb(0, 0, 0);
  }
  const r = parseInt(cleaned.substring(0, 2), 16) / 255;
  const g = parseInt(cleaned.substring(2, 4), 16) / 255;
  const b = parseInt(cleaned.substring(4, 6), 16) / 255;
  return rgb(
    Number.isFinite(r) ? r : 0,
    Number.isFinite(g) ? g : 0,
    Number.isFinite(b) ? b : 0
  );
}

/**
 * DataURL ごとの HTMLImageElement キャッシュ（Canvas上の同期描画用）
 * @type {Map<string, HTMLImageElement>}
 */
const imageElementCache = new Map();

/**
 * DataURL からキャッシュ済みの HTMLImageElement を取得する（未ロードの場合は非同期ロードを開始）
 * @param {string} dataUrl - 画像の DataURL
 * @param {() => void} [onLoad] - 非同期ロード完了時に呼ばれるコールバック
 * @returns {HTMLImageElement | null} ロード完了済みの場合は HTMLImageElement、ロード中は null
 */
export function getCachedImageElement(dataUrl, onLoad) {
  if (!dataUrl || typeof Image === 'undefined') {
    return null;
  }
  const existing = imageElementCache.get(dataUrl);
  if (existing) {
    if (existing.complete && existing.naturalWidth > 0) {
      return existing;
    }
    if (typeof onLoad === 'function') {
      existing.addEventListener('load', onLoad, { once: true });
    }
    return null;
  }

  const img = new Image();
  if (typeof onLoad === 'function') {
    img.addEventListener('load', onLoad, { once: true });
  }
  img.src = dataUrl;
  imageElementCache.set(dataUrl, img);
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/**
 * 画像 File または Blob を読み込み、Canvas描画および pdf-lib 埋め込みに適した DataURL とサイズ情報を返す
 * WebP / GIF / BMP 等の場合、または PNG / JPEG 以外の形式は透過保持の PNG DataURL へ自動変換する
 *
 * @param {File | Blob} file - 画像ファイル (.png, .jpg, .jpeg, .webp 等)
 * @returns {Promise<{
 *   dataUrl: string,
 *   mimeType: 'image/png' | 'image/jpeg',
 *   width: number,
 *   height: number,
 *   aspectRatio: number,
 *   imageName: string
 * }>}
 */
export async function loadImageFileForEditor(file) {
  if (!file) {
    throw new Error('画像ファイルが指定されていません。');
  }

  const rawDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () =>
      reject(new Error('画像ファイルの読み込みに失敗しました。'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () =>
      reject(new Error('画像データのデコードに失敗しました。'));
    el.src = rawDataUrl;
  });

  const naturalWidth = Math.max(1, img.naturalWidth || img.width || 100);
  const naturalHeight = Math.max(1, img.naturalHeight || img.height || 100);

  let finalDataUrl = rawDataUrl;
  let finalMimeType = 'image/png';

  const lowerType = (file.type || '').toLowerCase();
  const lowerName = (file.name || '').toLowerCase();

  if (
    lowerType === 'image/jpeg' ||
    lowerType === 'image/jpg' ||
    lowerName.endsWith('.jpg') ||
    lowerName.endsWith('.jpeg')
  ) {
    finalMimeType = 'image/jpeg';
  } else if (lowerType === 'image/png' || lowerName.endsWith('.png')) {
    finalMimeType = 'image/png';
  } else {
    // WebP / GIF / BMP / SVG 等はオフスクリーンCanvasで透過PNGに正規化
    const offCanvas = document.createElement('canvas');
    offCanvas.width = naturalWidth;
    offCanvas.height = naturalHeight;
    const offCtx = offCanvas.getContext('2d');
    offCtx.drawImage(img, 0, 0, naturalWidth, naturalHeight);
    finalDataUrl = offCanvas.toDataURL('image/png');
    finalMimeType = 'image/png';
  }

  // キャッシュに登録して即座に同期描画可能にする
  imageElementCache.set(finalDataUrl, img);

  return {
    dataUrl: finalDataUrl,
    mimeType: finalMimeType,
    width: naturalWidth,
    height: naturalHeight,
    aspectRatio: naturalWidth / naturalHeight,
    imageName: file.name || 'pasted-image.png'
  };
}

/**
 * DataURL 文字列から Uint8Array バイナリへ変換する
 * @param {string} dataUrl - Base64 DataURL
 * @returns {Uint8Array}
 */
function dataUrlToUint8Array(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * 任意の画像 DataURL をオフスクリーンCanvas経由で標準PNGバイト列に変換する（フォールバック用）
 * @param {string} dataUrl - 元画像の DataURL
 * @returns {Promise<Uint8Array>} PNGバイト配列
 */
async function convertDataUrlToPngBytesViaCanvas(dataUrl) {
  const img = await new Promise((resolve, reject) => {
    const cached = imageElementCache.get(dataUrl);
    if (cached && cached.complete && cached.naturalWidth > 0) {
      resolve(cached);
      return;
    }
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('画像の再変換に失敗しました。'));
    el.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, img.naturalWidth || img.width || 100);
  canvas.height = Math.max(1, img.naturalHeight || img.height || 100);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const pngDataUrl = canvas.toDataURL('image/png');
  return dataUrlToUint8Array(pngDataUrl);
}

/**
 * 出力先の PDFDocument に対して画像（PNGまたはJPEG）を埋め込み、キャッシュして返す
 * @param {object} outputPdf - pdf-lib の PDFDocument インスタンス
 * @param {object} edit - 画像編集要素 ({ dataUrl, mimeType })
 * @param {Map<string, object>} docImageCache - ドキュメント単位の埋め込み済み PDFImage キャッシュ
 * @returns {Promise<object | null>} 埋め込まれた PDFImage インスタンス
 */
async function resolveEmbeddedImageForPdf(outputPdf, edit, docImageCache) {
  const dataUrl = edit?.dataUrl;
  if (!dataUrl) {
    return null;
  }
  if (docImageCache.has(dataUrl)) {
    return docImageCache.get(dataUrl);
  }

  try {
    const rawBytes = dataUrlToUint8Array(dataUrl);
    const isJpeg =
      edit.mimeType === 'image/jpeg' ||
      dataUrl.startsWith('data:image/jpeg') ||
      dataUrl.startsWith('data:image/jpg');

    let embeddedImg = null;
    try {
      embeddedImg = isJpeg
        ? await outputPdf.embedJpg(rawBytes)
        : await outputPdf.embedPng(rawBytes);
    } catch {
      // 特殊なプログレッシブJPEGや非標準チャンク等で失敗した場合はCanvas経由でPNG化して確実に埋め込む
      const fallbackPngBytes = await convertDataUrlToPngBytesViaCanvas(dataUrl);
      embeddedImg = await outputPdf.embedPng(fallbackPngBytes);
    }

    if (embeddedImg) {
      docImageCache.set(dataUrl, embeddedImg);
    }
    return embeddedImg;
  } catch (error) {
    console.warn('PDFへの画像埋め込みに失敗しました:', error);
    return null;
  }
}

/**
 * ビューア上の座標点 (px, py) を回転考慮で未回転PDFページ座標 (X, Y) に変換する内部ヘルパー
 */
function mapViewerPointToPdfPoint(
  px,
  py,
  normalizedRot,
  x0,
  y0,
  rawWidth,
  rawHeight
) {
  if (normalizedRot === 0) {
    return { x: x0 + px, y: y0 + rawHeight - py };
  }
  if (normalizedRot === 90) {
    return { x: x0 + py, y: y0 + px };
  }
  if (normalizedRot === 180) {
    return { x: x0 + rawWidth - px, y: y0 + py };
  }
  // normalizedRot === 270
  return { x: x0 + rawWidth - py, y: y0 + rawHeight - px };
}

/**
 * ビューア上の矩形領域 (xv, yv, wv, hv) を未回転PDFページ上の軸平行バウンディングボックスに変換する内部ヘルパー
 */
function computeRotatedViewBoxInPdfSpace(
  xv,
  yv,
  wv,
  hv,
  normalizedRot,
  x0,
  y0,
  rawWidth,
  rawHeight
) {
  if (normalizedRot === 0) {
    return {
      rectX: x0 + xv,
      rectY: y0 + rawHeight - yv - hv,
      rectW: wv,
      rectH: hv
    };
  }
  if (normalizedRot === 90) {
    return {
      rectX: x0 + yv,
      rectY: y0 + xv,
      rectW: hv,
      rectH: wv
    };
  }
  if (normalizedRot === 180) {
    return {
      rectX: x0 + rawWidth - xv - wv,
      rectY: y0 + yv,
      rectW: wv,
      rectH: hv
    };
  }
  // normalizedRot === 270
  return {
    rectX: x0 + rawWidth - yv - hv,
    rectY: y0 + rawHeight - xv - wv,
    rectW: hv,
    rectH: wv
  };
}

/**
 * ビューア上の矩形 (xv, yv, wv, hv) を回転考慮で pdf-lib ページに塗りつぶし描画する内部ヘルパー
 */
function drawRotatedViewRectOnPdfPage(
  pdfPage,
  xv,
  yv,
  wv,
  hv,
  colorRgb,
  normalizedRot,
  x0,
  y0,
  rawWidth,
  rawHeight
) {
  const { rectX, rectY, rectW, rectH } = computeRotatedViewBoxInPdfSpace(
    xv,
    yv,
    wv,
    hv,
    normalizedRot,
    x0,
    y0,
    rawWidth,
    rawHeight
  );

  pdfPage.drawRectangle({
    x: rectX,
    y: rectY,
    width: Math.max(0.5, rectW),
    height: Math.max(0.5, rectH),
    color: colorRgb,
    opacity: 1
  });
}

/**
 * ビューア上の図形（□ 四角形 / 〇 丸・楕円 / △ 三角形 / ✓ チェック / × バツ印 / ― 直線）を
 * 回転考慮で pdf-lib ページにベクター描画する内部ヘルパー
 */
function drawRotatedViewShapeOnPdfPage(
  pdfPage,
  edit,
  xv,
  yv,
  wv,
  hv,
  normalizedRot,
  x0,
  y0,
  rawWidth,
  rawHeight
) {
  const { LineCapStyle } = window.PDFLib;
  const shapeType = edit.shapeType || 'rect';
  const strokeWidth = Math.max(0.5, Number(edit.strokeWidthPt) || 2);
  const strokeColorRgb = hexToPdfRgb(edit.strokeColor || '#000000');
  const fillColorRgb = edit.fillEnabled
    ? hexToPdfRgb(edit.fillColor || '#ffffff')
    : null;

  const { rectX, rectY, rectW, rectH } = computeRotatedViewBoxInPdfSpace(
    xv,
    yv,
    wv,
    hv,
    normalizedRot,
    x0,
    y0,
    rawWidth,
    rawHeight
  );

  if (shapeType === 'rect') {
    const opts = {
      x: rectX,
      y: rectY,
      width: Math.max(0.5, rectW),
      height: Math.max(0.5, rectH),
      borderColor: strokeColorRgb,
      borderWidth: strokeWidth,
      borderOpacity: 1
    };
    if (fillColorRgb) {
      opts.color = fillColorRgb;
      opts.opacity = 1;
    }
    pdfPage.drawRectangle(opts);
    return;
  }

  if (shapeType === 'circle') {
    const opts = {
      x: rectX + rectW / 2,
      y: rectY + rectH / 2,
      xScale: Math.max(0.5, rectW / 2),
      yScale: Math.max(0.5, rectH / 2),
      borderColor: strokeColorRgb,
      borderWidth: strokeWidth,
      borderOpacity: 1
    };
    if (fillColorRgb) {
      opts.color = fillColorRgb;
      opts.opacity = 1;
    }
    pdfPage.drawEllipse(opts);
    return;
  }

  const mapPt = (px, py) =>
    mapViewerPointToPdfPoint(
      px,
      py,
      normalizedRot,
      x0,
      y0,
      rawWidth,
      rawHeight
    );

  const lineCap = LineCapStyle ? LineCapStyle.Round : undefined;

  if (shapeType === 'triangle') {
    const p1 = mapPt(xv + wv / 2, yv);
    const p2 = mapPt(xv + wv, yv + hv);
    const p3 = mapPt(xv, yv + hv);

    if (fillColorRgb && typeof pdfPage.drawSvgPath === 'function') {
      // pdf-lib の drawSvgPath は Y 座標を反転するため -y を指定して正確なPDF座標に一致させる
      const svgPath = `M ${p1.x} ${-p1.y} L ${p2.x} ${-p2.y} L ${p3.x} ${-p3.y} Z`;
      pdfPage.drawSvgPath(svgPath, {
        x: 0,
        y: 0,
        color: fillColorRgb,
        borderColor: strokeColorRgb,
        borderWidth: strokeWidth
      });
    } else {
      pdfPage.drawLine({
        start: p1,
        end: p2,
        thickness: strokeWidth,
        color: strokeColorRgb,
        lineCap
      });
      pdfPage.drawLine({
        start: p2,
        end: p3,
        thickness: strokeWidth,
        color: strokeColorRgb,
        lineCap
      });
      pdfPage.drawLine({
        start: p3,
        end: p1,
        thickness: strokeWidth,
        color: strokeColorRgb,
        lineCap
      });
    }
    return;
  }

  if (shapeType === 'check') {
    const p1 = mapPt(xv + wv * 0.14, yv + hv * 0.54);
    const p2 = mapPt(xv + wv * 0.42, yv + hv * 0.84);
    const p3 = mapPt(xv + wv * 0.88, yv + hv * 0.18);
    pdfPage.drawLine({
      start: p1,
      end: p2,
      thickness: strokeWidth,
      color: strokeColorRgb,
      lineCap
    });
    pdfPage.drawLine({
      start: p2,
      end: p3,
      thickness: strokeWidth,
      color: strokeColorRgb,
      lineCap
    });
    return;
  }

  if (shapeType === 'cross') {
    const p1 = mapPt(xv + wv * 0.15, yv + hv * 0.15);
    const p2 = mapPt(xv + wv * 0.85, yv + hv * 0.85);
    const p3 = mapPt(xv + wv * 0.85, yv + hv * 0.15);
    const p4 = mapPt(xv + wv * 0.15, yv + hv * 0.85);
    pdfPage.drawLine({
      start: p1,
      end: p2,
      thickness: strokeWidth,
      color: strokeColorRgb,
      lineCap
    });
    pdfPage.drawLine({
      start: p3,
      end: p4,
      thickness: strokeWidth,
      color: strokeColorRgb,
      lineCap
    });
    return;
  }

  if (shapeType === 'line') {
    const p1 = mapPt(xv, yv + hv / 2);
    const p2 = mapPt(xv + wv, yv + hv / 2);
    pdfPage.drawLine({
      start: p1,
      end: p2,
      thickness: strokeWidth,
      color: strokeColorRgb,
      lineCap
    });
  }
}

/**
 * ビューア上の画像矩形 (xv, yv, wv, hv) を回転考慮で pdf-lib ページに描画する内部ヘルパー
 */
function drawRotatedViewImageOnPdfPage(
  pdfPage,
  embeddedImage,
  xv,
  yv,
  wv,
  hv,
  normalizedRot,
  x0,
  y0,
  rawWidth,
  rawHeight
) {
  if (!embeddedImage) {
    return;
  }
  const { degrees } = window.PDFLib;
  let imgX = x0 + xv;
  let imgY = y0 + rawHeight - yv - hv;
  let imgRotateAngle = 0;

  if (normalizedRot === 0) {
    imgX = x0 + xv;
    imgY = y0 + rawHeight - yv - hv;
    imgRotateAngle = 0;
  } else if (normalizedRot === 90) {
    imgX = x0 + yv + hv;
    imgY = y0 + xv;
    imgRotateAngle = 90;
  } else if (normalizedRot === 180) {
    imgX = x0 + rawWidth - xv;
    imgY = y0 + yv + hv;
    imgRotateAngle = 180;
  } else if (normalizedRot === 270) {
    imgX = x0 + rawWidth - yv - hv;
    imgY = y0 + rawHeight - xv;
    imgRotateAngle = -90;
  }

  pdfPage.drawImage(embeddedImage, {
    x: imgX,
    y: imgY,
    width: Math.max(1, wv),
    height: Math.max(1, hv),
    rotate: degrees(imgRotateAngle)
  });
}

/**
 * ビューア上の左上基準座標 (xv, yv) にテキストを回転考慮で pdf-lib ページに描画する内部ヘルパー
 */
function drawRotatedViewTextOnPdfPage(
  pdfPage,
  text,
  xv,
  yv,
  fontSize,
  colorRgb,
  customFont,
  normalizedRot,
  x0,
  y0,
  rawWidth,
  rawHeight
) {
  if (!text) {
    return;
  }
  const { degrees } = window.PDFLib;
  const ascentOffset = fontSize * 0.82;
  const baselineYv = yv + ascentOffset;

  let textX = x0;
  let textY = y0;
  let textRotateAngle = 0;

  if (normalizedRot === 0) {
    textX = x0 + xv;
    textY = y0 + rawHeight - baselineYv;
    textRotateAngle = 0;
  } else if (normalizedRot === 90) {
    textX = x0 + baselineYv;
    textY = y0 + xv;
    textRotateAngle = 90;
  } else if (normalizedRot === 180) {
    textX = x0 + rawWidth - xv;
    textY = y0 + baselineYv;
    textRotateAngle = 180;
  } else if (normalizedRot === 270) {
    textX = x0 + rawWidth - baselineYv;
    textY = y0 + rawHeight - xv;
    textRotateAngle = -90;
  }

  const drawOptions = {
    x: textX,
    y: textY,
    size: fontSize,
    color: colorRgb,
    rotate: degrees(textRotateAngle)
  };

  if (customFont) {
    drawOptions.font = customFont;
  }

  pdfPage.drawText(String(text), drawOptions);
}

/**
 * ビューア上の左上原点正規化座標 (0.0〜1.0) を、ページの回転角度を考慮して
 * pdf-lib の未回転ページ座標系 (左下原点) へ変換し、白塗り・既存テキスト置換・新規テキスト・図形・画像を描画する
 *
 * @param {object} outputPdf - pdf-lib の出力 PDFDocument
 * @param {object} pdfPage - pdf-lib の PDFPage インスタンス
 * @param {Array<object>} edits - ページに対する編集操作の配列
 * @param {number} totalRotation - 合算後のページ回転角 (0, 90, 180, 270)
 * @param {Map<string, object>} docFontCache - 埋め込み済みフォントのキャッシュマップ
 * @param {Map<string, object>} docImageCache - 埋め込み済み画像のキャッシュマップ
 */
async function applyEditsToPdfPage(
  outputPdf,
  pdfPage,
  edits,
  totalRotation,
  docFontCache,
  docImageCache
) {
  if (!edits || edits.length === 0) {
    return;
  }

  const box = pdfPage.getCropBox() || pdfPage.getMediaBox();
  const x0 = box.x || 0;
  const y0 = box.y || 0;
  const rawWidth = box.width;
  const rawHeight = box.height;

  const normalizedRot = normalizeRotation(totalRotation);
  const viewWidth = normalizedRot === 90 || normalizedRot === 270 ? rawHeight : rawWidth;
  const viewHeight = normalizedRot === 90 || normalizedRot === 270 ? rawWidth : rawHeight;

  for (const edit of edits) {
    if (edit.type === 'whiteout') {
      const xv = edit.xRatio * viewWidth;
      const yv = edit.yRatio * viewHeight;
      const wv = edit.widthRatio * viewWidth;
      const hv = edit.heightRatio * viewHeight;
      const fillColor = hexToPdfRgb(edit.bgColor || '#ffffff');

      drawRotatedViewRectOnPdfPage(
        pdfPage,
        xv,
        yv,
        wv,
        hv,
        fillColor,
        normalizedRot,
        x0,
        y0,
        rawWidth,
        rawHeight
      );
    } else if (edit.type === 'shape') {
      const xv = edit.xRatio * viewWidth;
      const yv = edit.yRatio * viewHeight;
      const wv = (edit.widthRatio || 0.08) * viewWidth;
      const hv = (edit.heightRatio || 0.08) * viewHeight;

      drawRotatedViewShapeOnPdfPage(
        pdfPage,
        edit,
        xv,
        yv,
        wv,
        hv,
        normalizedRot,
        x0,
        y0,
        rawWidth,
        rawHeight
      );
    } else if (edit.type === 'image' && edit.dataUrl) {
      const embeddedImage = await resolveEmbeddedImageForPdf(
        outputPdf,
        edit,
        docImageCache || new Map()
      );
      if (embeddedImage) {
        const xv = edit.xRatio * viewWidth;
        const yv = edit.yRatio * viewHeight;
        const wv = (edit.widthRatio || 0.2) * viewWidth;
        const hv = (edit.heightRatio || 0.2) * viewHeight;

        drawRotatedViewImageOnPdfPage(
          pdfPage,
          embeddedImage,
          xv,
          yv,
          wv,
          hv,
          normalizedRot,
          x0,
          y0,
          rawWidth,
          rawHeight
        );
      }
    } else if (edit.type === 'replace-text') {
      const maskX = (edit.maskXRatio ?? edit.xRatio) * viewWidth;
      const maskY = (edit.maskYRatio ?? edit.yRatio) * viewHeight;
      const maskW = (edit.maskWidthRatio || 0.05) * viewWidth;
      const maskH = (edit.maskHeightRatio || 0.025) * viewHeight;
      const maskColor = hexToPdfRgb(edit.bgColor || '#ffffff');

      drawRotatedViewRectOnPdfPage(
        pdfPage,
        maskX,
        maskY,
        maskW,
        maskH,
        maskColor,
        normalizedRot,
        x0,
        y0,
        rawWidth,
        rawHeight
      );

      if (edit.text && String(edit.text).length > 0) {
        const fontSize = Number(edit.fontSizePt) || 12;
        const textColor = hexToPdfRgb(edit.color || '#000000');
        const fontKey = edit.fontFamily || 'noto-sans';
        const customFont = await resolveEmbeddedFontForPdf(
          outputPdf,
          fontKey,
          edit.text,
          docFontCache
        );
        const xv = edit.xRatio * viewWidth;
        const yv = edit.yRatio * viewHeight;

        drawRotatedViewTextOnPdfPage(
          pdfPage,
          edit.text,
          xv,
          yv,
          fontSize,
          textColor,
          customFont,
          normalizedRot,
          x0,
          y0,
          rawWidth,
          rawHeight
        );
      }
    } else if (edit.type === 'text' && edit.text) {
      const fontSize = Number(edit.fontSizePt) || 16;
      const textColor = hexToPdfRgb(edit.color || '#000000');
      const fontKey = edit.fontFamily || 'noto-sans';
      const customFont = await resolveEmbeddedFontForPdf(
        outputPdf,
        fontKey,
        edit.text,
        docFontCache
      );
      const xv = edit.xRatio * viewWidth;
      const yv = edit.yRatio * viewHeight;

      drawRotatedViewTextOnPdfPage(
        pdfPage,
        edit.text,
        xv,
        yv,
        fontSize,
        textColor,
        customFont,
        normalizedRot,
        x0,
        y0,
        rawWidth,
        rawHeight
      );
    }
  }
}

/**
 * 通しページ番号をページの指定位置（上下左右・中央マージン）に指定フォント・サイズで描画する
 *
 * @param {object} pdfPage - pdf-lib の PDFPage インスタンス
 * @param {string} pageNumberText - 印字するページ番号文字列
 * @param {string} position - 表示位置 ('bottom-center' | 'bottom-right' | 'bottom-left' | 'top-center' | 'top-right' | 'top-left')
 * @param {number} fontSize - フォントサイズ (pt)
 * @param {number} totalRotation - 合算回転角 (0, 90, 180, 270)
 * @param {object | null} customFont - 埋め込みフォント
 */
function applyPageNumberToPdfPage(
  pdfPage,
  pageNumberText,
  position,
  fontSize,
  totalRotation,
  customFont
) {
  if (!pageNumberText) {
    return;
  }

  const { rgb } = window.PDFLib;
  const box = pdfPage.getCropBox() || pdfPage.getMediaBox();
  const x0 = box.x || 0;
  const y0 = box.y || 0;
  const rawWidth = box.width;
  const rawHeight = box.height;

  const normalizedRot = normalizeRotation(totalRotation);
  const viewWidth = normalizedRot === 90 || normalizedRot === 270 ? rawHeight : rawWidth;
  const viewHeight = normalizedRot === 90 || normalizedRot === 270 ? rawWidth : rawHeight;

  const effectiveSize = Number(fontSize) || 10.5;
  const marginX = 28;
  const marginY = 20;

  let textWidth = pageNumberText.length * effectiveSize * 0.52;
  if (customFont && typeof customFont.widthOfTextAtSize === 'function') {
    try {
      textWidth = customFont.widthOfTextAtSize(pageNumberText, effectiveSize);
    } catch {
      // フォールバック幅を使用
    }
  }

  let xv = (viewWidth - textWidth) / 2;
  let yv = viewHeight - marginY - effectiveSize;

  if (position.endsWith('-left')) {
    xv = marginX;
  } else if (position.endsWith('-right')) {
    xv = Math.max(marginX, viewWidth - marginX - textWidth);
  } else {
    xv = Math.max(8, (viewWidth - textWidth) / 2);
  }

  if (position.startsWith('top-')) {
    yv = marginY;
  } else {
    yv = Math.max(8, viewHeight - marginY - effectiveSize);
  }

  drawRotatedViewTextOnPdfPage(
    pdfPage,
    pageNumberText,
    xv,
    yv,
    effectiveSize,
    rgb(0.15, 0.18, 0.24),
    customFont,
    normalizedRot,
    x0,
    y0,
    rawWidth,
    rawHeight
  );
}

/**
 * 現在のページリストの順序・空白頁・回転角・編集内容・通しページ番号設定に基づいて
 * 新しいPDFを再構成してバイナリを生成する
 *
 * @param {Map<string, { id: string, fileName: string, pdfBytes: Uint8Array }>} sourceFilesMap - 元ファイルマップ
 * @param {Array<object>} pageList - ページ状態の配列
 * @param {object} pageNumberConfig - 通しページ番号の一括設定
 * @param {(current: number, total: number, statusText: string) => void} [onProgress] - 進捗通知コールバック
 * @returns {Promise<Uint8Array>} 生成されたPDFバイナリ
 */
export async function buildExportPdf(
  sourceFilesMap,
  pageList,
  pageNumberConfig,
  onProgress
) {
  const { PDFDocument, degrees } = window.PDFLib;
  if (!PDFDocument) {
    throw new Error('pdf-lib ライブラリが読み込まれていません。');
  }
  if (!pageList || pageList.length === 0) {
    throw new Error('エクスポート対象のページがありません。');
  }

  const outputPdf = await PDFDocument.create();
  const totalPages = pageList.length;

  // ドキュメント単位のフォント・画像埋め込みキャッシュ
  const docFontCache = new Map();
  const docImageCache = new Map();
  const loadedSourceDocs = new Map();

  // 全ページの通しページ番号（開始ページ・番号飛ばし考慮済み）を一括計算
  const computedPageNumbers = computePageNumbersForAllPages(
    pageList,
    pageNumberConfig
  );

  for (let i = 0; i < totalPages; i++) {
    const pageItem = pageList[i];
    if (onProgress) {
      onProgress(
        i + 1,
        totalPages,
        `ページを結合・描画中 (${i + 1} / ${totalPages} ページ)...`
      );
    }

    let targetPage = null;
    let totalRotation = 0;

    if (pageItem.type === 'blank') {
      const blankW = Number(pageItem.width) || 595.28;
      const blankH = Number(pageItem.height) || 841.89;
      targetPage = outputPdf.addPage([blankW, blankH]);
      totalRotation = normalizeRotation(pageItem.rotation || 0);
      targetPage.setRotation(degrees(totalRotation));
    } else {
      const sourceEntry = sourceFilesMap.get(pageItem.sourceFileId);
      if (!sourceEntry) {
        throw new Error(
          `元ファイルのデータが見つかりません (ID: ${pageItem.sourceFileId})`
        );
      }

      let srcPdfDoc = loadedSourceDocs.get(pageItem.sourceFileId);
      if (!srcPdfDoc) {
        srcPdfDoc = await PDFDocument.load(sourceEntry.pdfBytes.slice(0), {
          ignoreEncryption: true,
          updateMetadata: false
        });
        loadedSourceDocs.set(pageItem.sourceFileId, srcPdfDoc);
      }

      const [copiedPage] = await outputPdf.copyPages(srcPdfDoc, [
        pageItem.pageIndex
      ]);
      outputPdf.addPage(copiedPage);
      targetPage = copiedPage;

      const originalAngle = copiedPage.getRotation().angle || 0;
      const userRotation = pageItem.rotation || 0;
      totalRotation = normalizeRotation(originalAngle + userRotation);
      targetPage.setRotation(degrees(totalRotation));
    }

    // 1. 白塗り・図形・画像・既存テキスト置換/削除・新規テキスト追記の描画
    if (Array.isArray(pageItem.edits) && pageItem.edits.length > 0) {
      await applyEditsToPdfPage(
        outputPdf,
        targetPage,
        pageItem.edits,
        totalRotation,
        docFontCache,
        docImageCache
      );
    }

    // 2. 通しページ番号の描画（指定されたページ番号フォント・サイズ・開始ページ・番号飛ばしに対応）
    const pageNumInfo = computedPageNumbers[i];
    if (pageNumInfo && pageNumInfo.visible) {
      const pageNumFont = await resolveEmbeddedFontForPdf(
        outputPdf,
        pageNumInfo.fontFamily,
        pageNumInfo.text,
        docFontCache
      );
      applyPageNumberToPdfPage(
        targetPage,
        pageNumInfo.text,
        pageNumInfo.position,
        pageNumInfo.fontSizePt,
        totalRotation,
        pageNumFont
      );
    }
  }

  if (onProgress) {
    onProgress(totalPages, totalPages, 'PDFバイナリを生成しています...');
  }

  return await outputPdf.save();
}

/**
 * PDFバイナリをBlob化してブラウザの自動ダウンロードを実行する
 * @param {Uint8Array} pdfBytes - 保存するPDFのバイト配列
 * @param {string} [customFileName] - 任意のファイル名（省略時は processed_[timestamp].pdf）
 * @returns {string} ダウンロードされたファイル名
 */
export function triggerPdfDownload(pdfBytes, customFileName) {
  const timestamp = Date.now();
  const fileName = customFileName || `processed_${timestamp}.pdf`;

  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const blobUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();

  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(blobUrl);
  }, 1500);

  return fileName;
}

/**
 * ページが時計回りに90度（右へ +90°）回転された際、既存の編集データの正規化座標を変換する
 * @param {Array<object>} edits - 編集データの配列
 * @returns {Array<object>} 座標変換後の新しい編集データ配列
 */
export function rotateEditsClockwise90(edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return [];
  }

  return edits.map((edit) => {
    if (
      edit.type === 'whiteout' ||
      edit.type === 'shape' ||
      edit.type === 'image'
    ) {
      return {
        ...edit,
        xRatio: Math.max(0, Math.min(1, 1 - edit.yRatio - edit.heightRatio)),
        yRatio: Math.max(0, Math.min(1, edit.xRatio)),
        widthRatio: edit.heightRatio,
        heightRatio: edit.widthRatio
      };
    }
    if (edit.type === 'replace-text') {
      const mX = edit.maskXRatio ?? edit.xRatio;
      const mY = edit.maskYRatio ?? edit.yRatio;
      const mW = edit.maskWidthRatio || 0.05;
      const mH = edit.maskHeightRatio || 0.025;
      return {
        ...edit,
        xRatio: Math.max(0, Math.min(0.98, 1 - edit.yRatio)),
        yRatio: Math.max(0, Math.min(0.98, edit.xRatio)),
        maskXRatio: Math.max(0, Math.min(1, 1 - mY - mH)),
        maskYRatio: Math.max(0, Math.min(1, mX)),
        maskWidthRatio: mH,
        maskHeightRatio: mW
      };
    }
    if (edit.type === 'text') {
      return {
        ...edit,
        xRatio: Math.max(0, Math.min(0.95, 1 - edit.yRatio)),
        yRatio: Math.max(0, Math.min(0.95, edit.xRatio))
      };
    }
    return { ...edit };
  });
}

/**
 * ページが反時計回りに90度（左へ -90°）回転された際、既存の編集データの正規化座標を変換する
 * @param {Array<object>} edits - 編集データの配列
 * @returns {Array<object>} 座標変換後の新しい編集データ配列
 */
export function rotateEditsCounterClockwise90(edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return [];
  }

  return edits.map((edit) => {
    if (
      edit.type === 'whiteout' ||
      edit.type === 'shape' ||
      edit.type === 'image'
    ) {
      return {
        ...edit,
        xRatio: Math.max(0, Math.min(1, edit.yRatio)),
        yRatio: Math.max(0, Math.min(1, 1 - edit.xRatio - edit.widthRatio)),
        widthRatio: edit.heightRatio,
        heightRatio: edit.widthRatio
      };
    }
    if (edit.type === 'replace-text') {
      const mX = edit.maskXRatio ?? edit.xRatio;
      const mY = edit.maskYRatio ?? edit.yRatio;
      const mW = edit.maskWidthRatio || 0.05;
      const mH = edit.maskHeightRatio || 0.025;
      return {
        ...edit,
        xRatio: Math.max(0, Math.min(0.98, edit.yRatio)),
        yRatio: Math.max(0, Math.min(0.98, 1 - edit.xRatio)),
        maskXRatio: Math.max(0, Math.min(1, mY)),
        maskYRatio: Math.max(0, Math.min(1, 1 - mX - mW)),
        maskWidthRatio: mH,
        maskHeightRatio: mW
      };
    }
    if (edit.type === 'text') {
      return {
        ...edit,
        xRatio: Math.max(0, Math.min(0.95, edit.yRatio)),
        yRatio: Math.max(0, Math.min(0.95, 1 - edit.xRatio))
      };
    }
    return { ...edit };
  });
}
