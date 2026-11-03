/**
 * @file preview.js
 * @description pdf.js を用いた省メモリサムネイル描画、空白頁プレビュー、ページ番号インジケーター表示、および SortableJS 連携モジュール
 */

import {
  normalizeRotation,
  getEffectivePageDimensions,
  resolvePageNumberForPage,
  getCssFontFamily,
  getCachedImageElement
} from './pdf-engine.js';

// pdf.js Worker の指定漏れ防止（初期化前に必ず設定）
const PDFJS_CDN_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
if (typeof window !== 'undefined' && window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/**
 * サムネイル生成時の基準スケール（メモリ逼迫防止のため 0.2〜0.3 に制限）
 */
const THUMBNAIL_DEFAULT_SCALE = 0.25;
const THUMBNAIL_MIN_SCALE = 0.2;
const THUMBNAIL_MAX_SCALE = 0.3;
const THUMBNAIL_TARGET_WIDTH_PX = 180;

/**
 * PDFバイナリから pdf.js のドキュメントインスタンス (PDFDocumentProxy) を読み込む
 * @param {Uint8Array} pdfBytes - PDFファイルのバイト配列
 * @returns {Promise<object>} pdf.js の PDFDocumentProxy
 */
export async function loadPdfJsDoc(pdfBytes) {
  const pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) {
    throw new Error('pdf.js ライブラリが読み込まれていません。');
  }

  // Worker への Transfer による元バッファの detach を防ぐため、必ずコピー (.slice(0)) を渡す
  const loadingTask = pdfjsLib.getDocument({
    data: pdfBytes.slice(0),
    cMapUrl: `${PDFJS_CDN_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_CDN_BASE}/standard_fonts/`
  });

  return await loadingTask.promise;
}

/**
 * 2D Canvasコンテキスト上に単一の図形要素（□ 四角形 / 〇 丸・楕円 / △ 三角形 / ✓ チェック / × バツ印 / ― 直線）を描画する
 *
 * @param {CanvasRenderingContext2D} ctx - 描画先2Dコンテキスト
 * @param {object} shapeConfig - 図形設定 ({ shapeType, strokeColor, fillEnabled, fillColor, strokeWidthPt })
 * @param {number} x - 描画領域左上X (px)
 * @param {number} y - 描画領域左上Y (px)
 * @param {number} w - 描画領域幅 (px)
 * @param {number} h - 描画領域高さ (px)
 * @param {number} [scaleFactor=1] - PDFポイントからピクセルへの換算比率
 */
export function drawShapeOnCanvasContext(
  ctx,
  shapeConfig,
  x,
  y,
  w,
  h,
  scaleFactor = 1
) {
  if (!ctx || !shapeConfig) {
    return;
  }

  const shapeType = shapeConfig.shapeType || 'rect';
  const strokeWidthPx = Math.max(
    1,
    (Number(shapeConfig.strokeWidthPt) || 2) * scaleFactor
  );
  const strokeColor = shapeConfig.strokeColor || '#000000';
  const fillEnabled = Boolean(shapeConfig.fillEnabled);
  const fillColor = shapeConfig.fillColor || '#ffffff';

  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidthPx;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (shapeType === 'rect') {
    if (fillEnabled) {
      ctx.fillStyle = fillColor;
      ctx.fillRect(x, y, w, h);
    }
    ctx.strokeRect(x, y, w, h);
  } else if (shapeType === 'circle') {
    ctx.beginPath();
    ctx.ellipse(
      x + w / 2,
      y + h / 2,
      Math.max(1, w / 2),
      Math.max(1, h / 2),
      0,
      0,
      Math.PI * 2
    );
    if (fillEnabled) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    ctx.stroke();
  } else if (shapeType === 'triangle') {
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    if (fillEnabled) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    ctx.stroke();
  } else if (shapeType === 'check') {
    ctx.beginPath();
    ctx.moveTo(x + w * 0.14, y + h * 0.54);
    ctx.lineTo(x + w * 0.42, y + h * 0.84);
    ctx.lineTo(x + w * 0.88, y + h * 0.18);
    ctx.stroke();
  } else if (shapeType === 'cross') {
    ctx.beginPath();
    ctx.moveTo(x + w * 0.15, y + h * 0.15);
    ctx.lineTo(x + w * 0.85, y + h * 0.85);
    ctx.moveTo(x + w * 0.85, y + h * 0.15);
    ctx.lineTo(x + w * 0.15, y + h * 0.85);
    ctx.stroke();
  } else if (shapeType === 'line') {
    ctx.beginPath();
    ctx.moveTo(x, y + h / 2);
    ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * 指定されたCanvasコンテキスト上に編集データ（白塗り矩形・図形・画像・既存テキスト置換/削除・新規テキスト追記）を描画する
 * サムネイルCanvasおよび拡大エディタCanvasの両方で共通利用できるヘルパー関数
 *
 * @param {CanvasRenderingContext2D} ctx - 描画先の2Dコンテキスト
 * @param {Array<object>} edits - 編集操作の配列
 * @param {number} canvasWidth - 描画先Canvasのピクセル幅
 * @param {number} canvasHeight - 描画先Canvasのピクセル高さ
 * @param {number} pdfPointWidth - スケール1.0時のPDFページ幅（フォントサイズ・線幅比率計算用）
 */
export function renderEditsOnCanvasContext(
  ctx,
  edits,
  canvasWidth,
  canvasHeight,
  pdfPointWidth
) {
  if (!ctx || !Array.isArray(edits) || edits.length === 0) {
    return;
  }

  const scaleFactor = pdfPointWidth > 0 ? canvasWidth / pdfPointWidth : 1;

  ctx.save();
  for (const edit of edits) {
    if (edit.type === 'whiteout') {
      const x = edit.xRatio * canvasWidth;
      const y = edit.yRatio * canvasHeight;
      const w = edit.widthRatio * canvasWidth;
      const h = edit.heightRatio * canvasHeight;

      ctx.fillStyle = edit.bgColor || '#ffffff';
      ctx.fillRect(x, y, w, h);
    } else if (edit.type === 'shape') {
      const x = edit.xRatio * canvasWidth;
      const y = edit.yRatio * canvasHeight;
      const w = (edit.widthRatio || 0.08) * canvasWidth;
      const h = (edit.heightRatio || 0.08) * canvasHeight;

      drawShapeOnCanvasContext(ctx, edit, x, y, w, h, scaleFactor);
    } else if (edit.type === 'image' && edit.dataUrl) {
      const x = edit.xRatio * canvasWidth;
      const y = edit.yRatio * canvasHeight;
      const w = (edit.widthRatio || 0.2) * canvasWidth;
      const h = (edit.heightRatio || 0.2) * canvasHeight;

      const imgElement = getCachedImageElement(edit.dataUrl);
      if (imgElement) {
        ctx.drawImage(imgElement, x, y, w, h);
      }
    } else if (edit.type === 'replace-text') {
      // 1. 元のテキスト領域を周囲背景色でマスク消去
      const mX = (edit.maskXRatio ?? edit.xRatio) * canvasWidth;
      const mY = (edit.maskYRatio ?? edit.yRatio) * canvasHeight;
      const mW = (edit.maskWidthRatio || 0.05) * canvasWidth;
      const mH = (edit.maskHeightRatio || 0.025) * canvasHeight;

      ctx.fillStyle = edit.bgColor || '#ffffff';
      ctx.fillRect(mX, mY, mW, mH);

      // 2. 置換後の文字列が存在する場合は描画
      if (edit.text && String(edit.text).length > 0) {
        const fontSizePt = Number(edit.fontSizePt) || 12;
        const fontSizePx = Math.max(4, fontSizePt * scaleFactor);
        const cssFont = getCssFontFamily(edit.fontFamily || 'noto-sans');
        const x = edit.xRatio * canvasWidth;
        const y = edit.yRatio * canvasHeight;

        ctx.font = `500 ${fontSizePx}px ${cssFont}`;
        ctx.fillStyle = edit.color || '#000000';
        ctx.textBaseline = 'top';
        ctx.fillText(String(edit.text), x, y);
      }
    } else if (edit.type === 'text' && edit.text) {
      const fontSizePt = Number(edit.fontSizePt) || 16;
      const fontSizePx = Math.max(4, fontSizePt * scaleFactor);
      const cssFont = getCssFontFamily(edit.fontFamily || 'noto-sans');
      const x = edit.xRatio * canvasWidth;
      const y = edit.yRatio * canvasHeight;

      ctx.font = `500 ${fontSizePx}px ${cssFont}`;
      ctx.fillStyle = edit.color || '#000000';
      ctx.textBaseline = 'top';
      ctx.fillText(String(edit.text), x, y);
    }
  }
  ctx.restore();
}

/**
 * 単一ページ（既存PDFページまたは空白ページ）のサムネイルを小さなCanvas（scale 0.2〜0.3）にレンダリングする
 *
 * @param {object} pageItem - ページ状態オブジェクト
 * @param {object | null} pdfJsDoc - pdf.js の PDFDocumentProxy（空白ページの場合は null 可）
 * @param {HTMLCanvasElement} canvas - 描画対象のCanvas要素
 * @returns {Promise<void>}
 */
export async function renderThumbnailCanvas(pageItem, pdfJsDoc, canvas) {
  if (!canvas || !pageItem) {
    return;
  }

  // 空白ページ (type === 'blank') のサムネイル描画
  if (pageItem.type === 'blank') {
    const { width: viewW, height: viewH } = getEffectivePageDimensions(pageItem);
    const idealScale = THUMBNAIL_TARGET_WIDTH_PX / (viewW || 595.28);
    const scale = Math.min(
      THUMBNAIL_MAX_SCALE,
      Math.max(THUMBNAIL_MIN_SCALE, idealScale || THUMBNAIL_DEFAULT_SCALE)
    );

    canvas.width = Math.max(1, Math.floor(viewW * scale));
    canvas.height = Math.max(1, Math.floor(viewH * scale));

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 編集がまだない場合はサムネイル中央に薄く「空白ページ」の透かしガイドを表示（出力PDFには含まれない）
    if (!Array.isArray(pageItem.edits) || pageItem.edits.length === 0) {
      ctx.save();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 11px "Noto Sans JP", "Inter", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('空白ページ', canvas.width / 2, canvas.height / 2 - 8);
      ctx.font = '400 9px "Inter", sans-serif';
      ctx.fillText(
        `${Math.round(viewW)}×${Math.round(viewH)} pt`,
        canvas.width / 2,
        canvas.height / 2 + 8
      );
      ctx.restore();
    } else {
      renderEditsOnCanvasContext(
        ctx,
        pageItem.edits,
        canvas.width,
        canvas.height,
        viewW
      );
    }
    return;
  }

  if (!pdfJsDoc) {
    return;
  }

  // pdf.js のページ番号は 1 始まり
  const pdfPage = await pdfJsDoc.getPage(pageItem.pageIndex + 1);

  // 元PDFの初期回転角とユーザーの追加回転角を合算
  const baseRotation = pdfPage.rotate || 0;
  const userRotation = pageItem.rotation || 0;
  const totalRotation = normalizeRotation(baseRotation + userRotation);

  // スケール1.0時のビューポートサイズを取得
  const unscaledViewport = pdfPage.getViewport({
    scale: 1.0,
    rotation: totalRotation
  });

  // 幅150〜200px程度かつ scale 0.2〜0.3 の範囲に収まる省メモリスケールを計算
  const idealScale = THUMBNAIL_TARGET_WIDTH_PX / (unscaledViewport.width || 600);
  const scale = Math.min(
    THUMBNAIL_MAX_SCALE,
    Math.max(THUMBNAIL_MIN_SCALE, idealScale || THUMBNAIL_DEFAULT_SCALE)
  );

  const viewport = pdfPage.getViewport({
    scale,
    rotation: totalRotation
  });

  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await pdfPage.render({
    canvasContext: ctx,
    viewport
  }).promise;

  // 編集内容（白塗り・既存テキスト置換・新規テキスト追記）がある場合はサムネイル上にも反映描画
  if (Array.isArray(pageItem.edits) && pageItem.edits.length > 0) {
    renderEditsOnCanvasContext(
      ctx,
      pageItem.edits,
      canvas.width,
      canvas.height,
      unscaledViewport.width
    );
  }
}

/**
 * カード内のステータスバッジ（回転角度・編集件数）および個別ページ番号セレクトの値を更新する
 *
 * @param {HTMLElement} cardElement - 対象のカードDOM要素
 * @param {object} pageItem - ページ状態オブジェクト
 */
export function updateCardStatusBadges(cardElement, pageItem) {
  if (!cardElement || !pageItem) {
    return;
  }

  const badgesContainer = cardElement.querySelector('.card-status-badges');
  if (badgesContainer) {
    badgesContainer.innerHTML = '';

    const userRotation = normalizeRotation(pageItem.rotation || 0);
    if (userRotation !== 0) {
      const rotPill = document.createElement('span');
      rotPill.className = 'status-pill rotation-pill';
      rotPill.textContent = `${userRotation}°`;
      badgesContainer.appendChild(rotPill);
    } else {
      const spacer = document.createElement('span');
      badgesContainer.appendChild(spacer);
    }

    const editsCount = Array.isArray(pageItem.edits) ? pageItem.edits.length : 0;
    if (editsCount > 0) {
      const editedPill = document.createElement('span');
      editedPill.className = 'status-pill edited-pill';
      editedPill.textContent = `編集済 (${editsCount})`;
      badgesContainer.appendChild(editedPill);
    }
  }

  // 個別ページ番号セレクトの同期
  const overrideSelect = cardElement.querySelector('.card-pagenum-override-select');
  if (overrideSelect) {
    overrideSelect.value = pageItem.pageNumberOverride || 'inherit';
  }
}

/**
 * カードのサムネイル上に、通しページ番号の付与位置と印字内容のリアルタイムインジケーターを更新表示する
 *
 * @param {HTMLElement} cardElement - 対象のカードDOM要素
 * @param {object} pageItem - ページ状態オブジェクト
 * @param {object} globalPageNumConfig - 通しページ番号の一括設定
 * @param {number} orderIndex - 0始まりのページ並び順インデックス
 * @param {number} totalPages - 全体の総ページ数
 */
export function updateCardPageNumberIndicator(
  cardElement,
  pageItem,
  globalPageNumConfig,
  orderIndex,
  totalPages,
  allPageList
) {
  if (!cardElement || !pageItem) {
    return;
  }

  const indicator = cardElement.querySelector('.card-pagenum-indicator');
  if (!indicator) {
    return;
  }

  const resolved = resolvePageNumberForPage(
    pageItem,
    globalPageNumConfig,
    orderIndex,
    totalPages,
    allPageList
  );

  // ページ番号設定が全体でOFFの場合
  if (!globalPageNumConfig?.enabled) {
    indicator.className = 'card-pagenum-indicator hidden';
    indicator.textContent = '';
    return;
  }

  // このページが非表示（番号飛ばし / 開始ページ前 / 印字のみ隠す）に設定されている場合
  if (resolved.isExplicitHidden) {
    indicator.className = 'card-pagenum-indicator pos-hidden';
    indicator.style.fontFamily = '';
    if (resolved.hiddenReason === 'count-only') {
      indicator.textContent = `印字なし (${resolved.text})`;
    } else if (resolved.hiddenReason === 'before-start') {
      indicator.textContent = '頁番号: 開始前';
    } else {
      indicator.textContent = '頁番号: 非表示';
    }
    return;
  }

  // 表示される場合：指定位置（上下左右中央）と指定フォントで実際のフォーマット済み文字列を配置
  indicator.className = `card-pagenum-indicator pos-${resolved.position}`;
  indicator.style.fontFamily = getCssFontFamily(resolved.fontFamily);
  indicator.textContent = resolved.text;
}

/**
 * ページサムネイルカードのDOM要素を生成し、各種イベントをバインドする
 *
 * @param {object} pageItem - ページ状態オブジェクト
 * @param {number} orderIndex - 現在の並び順インデックス (0始まり)
 * @param {object} callbacks - 操作コールバック群 ({ onRotateCcw, onRotateCw, onInsertBlankAfter, onDelete, onEdit, onPageNumOverrideChange })
 * @returns {HTMLElement} 生成されたカードDOM要素
 */
export function createPageCardElement(pageItem, orderIndex, callbacks) {
  const card = document.createElement('article');
  card.className =
    pageItem.type === 'blank' ? 'page-card is-blank-page' : 'page-card';
  card.dataset.pageId = pageItem.id;

  // カードヘッダー（現在の順番バッジ + 操作ボタン群）
  const header = document.createElement('div');
  header.className = 'card-header';
  header.title = 'ドラッグしてページの順序を並び替え';

  const orderBadge = document.createElement('span');
  orderBadge.className = 'card-order-badge';
  orderBadge.textContent = `#${orderIndex + 1}`;

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  // 左へ90度回転（反時計回り / -90°）ボタン
  const rotateCcwBtn = document.createElement('button');
  rotateCcwBtn.type = 'button';
  rotateCcwBtn.className = 'card-action-btn btn-rotate-ccw';
  rotateCcwBtn.title = '左へ90度回転（反時計回り / -90°）';
  rotateCcwBtn.setAttribute('aria-label', 'ページを左へ90度回転');
  rotateCcwBtn.innerHTML = '<i data-lucide="rotate-ccw"></i>';
  rotateCcwBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (callbacks && typeof callbacks.onRotateCcw === 'function') {
      callbacks.onRotateCcw(pageItem.id);
    }
  });

  // 右へ90度回転（時計回り / +90°）ボタン
  const rotateCwBtn = document.createElement('button');
  rotateCwBtn.type = 'button';
  rotateCwBtn.className = 'card-action-btn btn-rotate-cw';
  rotateCwBtn.title = '右へ90度回転（時計回り / +90°）';
  rotateCwBtn.setAttribute('aria-label', 'ページを右へ90度回転');
  rotateCwBtn.innerHTML = '<i data-lucide="rotate-cw"></i>';
  rotateCwBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (callbacks && typeof callbacks.onRotateCw === 'function') {
      callbacks.onRotateCw(pageItem.id);
    }
  });

  // この後ろに空白ページを挿入ボタン
  const insertBlankBtn = document.createElement('button');
  insertBlankBtn.type = 'button';
  insertBlankBtn.className = 'card-action-btn btn-insert-blank-after';
  insertBlankBtn.title = 'このページの後ろに空白ページを挿入';
  insertBlankBtn.setAttribute('aria-label', 'この後ろに空白ページを挿入');
  insertBlankBtn.innerHTML = '<i data-lucide="file-plus"></i>';
  insertBlankBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (callbacks && typeof callbacks.onInsertBlankAfter === 'function') {
      callbacks.onInsertBlankAfter(pageItem.id);
    }
  });

  // 編集モーダル起動ボタン
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'card-action-btn btn-edit-page';
  editBtn.title = 'ページを拡大して既存テキスト編集・文字追加・白塗り';
  editBtn.setAttribute('aria-label', 'ページを編集');
  editBtn.innerHTML = '<i data-lucide="edit-3"></i>';
  editBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (callbacks && typeof callbacks.onEdit === 'function') {
      callbacks.onEdit(pageItem.id);
    }
  });

  // ページ除外（削除・ゴミ箱）ボタン
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'card-action-btn btn-delete-page';
  deleteBtn.title = 'このページをリストから除外（削除）';
  deleteBtn.setAttribute('aria-label', 'ページを削除');
  deleteBtn.innerHTML = '<i data-lucide="trash-2"></i>';
  deleteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (callbacks && typeof callbacks.onDelete === 'function') {
      callbacks.onDelete(pageItem.id);
    }
  });

  actions.appendChild(rotateCcwBtn);
  actions.appendChild(rotateCwBtn);
  actions.appendChild(insertBlankBtn);
  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);

  header.appendChild(orderBadge);
  header.appendChild(actions);

  // サムネイルラッパー（クリックで拡大モーダル編集画面を開く）
  const thumbWrapper = document.createElement('div');
  thumbWrapper.className = 'card-thumbnail-wrapper';
  thumbWrapper.title = 'クリックしてページを拡大・編集（既存テキスト書換・文字追加・白塗り）';

  const canvasContainer = document.createElement('div');
  canvasContainer.className = 'thumbnail-canvas-container';

  const canvas = document.createElement('canvas');
  canvas.className = 'thumbnail-canvas';
  canvasContainer.appendChild(canvas);

  // サムネイル内リアルタイムページ番号インジケーター
  const pageNumIndicator = document.createElement('span');
  pageNumIndicator.className = 'card-pagenum-indicator hidden';
  canvasContainer.appendChild(pageNumIndicator);

  // ホバー時の編集ガイドピル
  const hoverOverlay = document.createElement('div');
  hoverOverlay.className = 'card-hover-overlay';
  hoverOverlay.innerHTML = `
    <span class="hover-edit-pill">
      <i data-lucide="zoom-in"></i>
      <span>拡大・テキスト編集</span>
    </span>
  `;

  // 回転・編集済みステータスバッジコンテナ
  const statusBadges = document.createElement('div');
  statusBadges.className = 'card-status-badges';

  thumbWrapper.appendChild(canvasContainer);
  thumbWrapper.appendChild(hoverOverlay);
  thumbWrapper.appendChild(statusBadges);

  thumbWrapper.addEventListener('click', () => {
    if (callbacks && typeof callbacks.onEdit === 'function') {
      callbacks.onEdit(pageItem.id);
    }
  });

  // ページ番号の個別オーバーライド設定行
  const settingsRow = document.createElement('div');
  settingsRow.className = 'card-settings-row';

  const pageNumSelect = document.createElement('select');
  pageNumSelect.className = 'card-pagenum-override-select';
  pageNumSelect.title = 'このページのページ番号表示方法を個別に設定';
  pageNumSelect.setAttribute('aria-label', 'ページ番号の個別設定');
  pageNumSelect.innerHTML = `
    <option value="inherit">頁番号: 一括設定に従う</option>
    <option value="hidden">頁番号: 番号を飛ばす / 非表示 (表紙等)</option>
    <option value="count-only">頁番号: 印字のみ隠す (番号は進める)</option>
    <option value="bottom-center">頁番号: 個別【下中央】</option>
    <option value="bottom-right">頁番号: 個別【下右】</option>
    <option value="bottom-left">頁番号: 個別【下左】</option>
    <option value="top-center">頁番号: 個別【上中央】</option>
    <option value="top-right">頁番号: 個別【上右】</option>
    <option value="top-left">頁番号: 個別【上左】</option>
  `;
  pageNumSelect.value = pageItem.pageNumberOverride || 'inherit';
  pageNumSelect.addEventListener('change', (event) => {
    event.stopPropagation();
    if (callbacks && typeof callbacks.onPageNumOverrideChange === 'function') {
      callbacks.onPageNumOverrideChange(pageItem.id, event.target.value);
    }
  });
  settingsRow.appendChild(pageNumSelect);

  // カードフッター（元ファイル名・元ページ番号 / 用紙サイズラベル）
  const footer = document.createElement('div');
  footer.className = 'card-footer';

  const fileNameSpan = document.createElement('span');
  fileNameSpan.className = 'card-filename';
  fileNameSpan.textContent = pageItem.fileName;
  fileNameSpan.title = pageItem.fileName;

  const origPageSpan = document.createElement('span');
  origPageSpan.className = 'card-orig-page';
  if (pageItem.type === 'blank') {
    origPageSpan.textContent = pageItem.paperLabel || '白紙';
    origPageSpan.title = '挿入された空白ページ';
  } else {
    origPageSpan.textContent = `元 P.${pageItem.pageIndex + 1}`;
    origPageSpan.title = `元ファイルの ${pageItem.pageIndex + 1} ページ目`;
  }

  footer.appendChild(fileNameSpan);
  footer.appendChild(origPageSpan);

  card.appendChild(header);
  card.appendChild(thumbWrapper);
  card.appendChild(settingsRow);
  card.appendChild(footer);

  updateCardStatusBadges(card, pageItem);

  return card;
}

/**
 * グリッド内のすべてのカードの現在の並び順インデックス表示 (#1, #2, ...) を再計算して更新する
 *
 * @param {HTMLElement} gridElement - カード一覧グリッド要素 (#page-grid)
 */
export function refreshGridOrderBadges(gridElement) {
  if (!gridElement) {
    return;
  }
  const cards = gridElement.querySelectorAll('.page-card');
  cards.forEach((card, index) => {
    const badge = card.querySelector('.card-order-badge');
    if (badge) {
      badge.textContent = `#${index + 1}`;
    }
  });
}

/**
 * SortableJS を初期化し、カードのドラッグ＆ドロップによる並び替えを有効化する
 *
 * @param {HTMLElement} gridElement - カード一覧グリッド要素 (#page-grid)
 * @param {(orderedPageIds: string[]) => void} onReorder - 並び替え完了時に新しいID配列を受け取るコールバック
 * @returns {object | null} Sortable インスタンス
 */
export function initSortableGrid(gridElement, onReorder) {
  if (!gridElement || typeof window.Sortable === 'undefined') {
    console.warn('SortableJS が読み込まれていないか、グリッド要素が見つかりません。');
    return null;
  }

  return new window.Sortable(gridElement, {
    animation: 180,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    // アクションボタンおよびセレクトボックス上の操作はドラッグから除外する
    filter: '.card-action-btn, .card-pagenum-override-select',
    preventOnFilter: false,
    onEnd: () => {
      const cards = Array.from(gridElement.querySelectorAll('.page-card'));
      const orderedIds = cards.map((card) => card.dataset.pageId).filter(Boolean);

      refreshGridOrderBadges(gridElement);

      if (typeof onReorder === 'function') {
        onReorder(orderedIds);
      }
    }
  });
}
