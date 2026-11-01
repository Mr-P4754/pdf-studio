/**
 * @file editor.js
 * @description ページ拡大モーダル画面でのダイレクトテキスト編集（pdf.js getTextContentによる既存文字検出・削除・置換）、
 * 新規テキスト追加・ドラッグ位置微調整、白塗り矩形描画、左右回転、ページ番号個別設定モジュール
 */

import {
  preloadJapaneseFont,
  getCssFontFamily,
  normalizeRotation,
  getEffectivePageDimensions,
  rotateEditsClockwise90,
  rotateEditsCounterClockwise90
} from './pdf-engine.js';
import { renderEditsOnCanvasContext } from './preview.js';

/**
 * モーダルエディタの内部ステート
 */
const editorState = {
  isInitialized: false,
  isOpen: false,
  currentPageItem: null,
  currentPdfJsDoc: null,
  currentOrderIndex: 0,
  currentPdfPointWidth: 595.28,
  currentPdfPointHeight: 841.89,
  currentTool: 'direct-text', // 'direct-text' | 'text' | 'whiteout'

  /**
   * pdf.js の getTextContent() から検出されたページ内の既存テキスト要素リスト
   * @type {Array<{
   *   key: string,
   *   originalText: string,
   *   xRatio: number,
   *   yRatio: number,
   *   maskXRatio: number,
   *   maskYRatio: number,
   *   maskWidthRatio: number,
   *   maskHeightRatio: number,
   *   fontSizePt: number
   * }>}
   */
  detectedTextItems: [],

  // 白塗りドラッグ用
  isDraggingWhiteout: false,
  dragStartX: 0,
  dragStartY: 0,
  dragCurrentX: 0,
  dragCurrentY: 0,

  // 既存・新規テキスト要素のドラッグ移動（位置微調整）用
  draggingEditItem: null,
  dragEditStartCanvasX: 0,
  dragEditStartCanvasY: 0,
  dragEditInitialXRatio: 0,
  dragEditInitialYRatio: 0,
  hasMovedDuringTextDrag: false,

  // ホバー中の既存テキスト枠または編集済みテキスト要素
  hoveredDetectedItemKey: null,
  hoveredEditId: null,

  /**
   * ポップオーバーで現在編集中のターゲット情報
   * mode: 'new-text' | 'edit-existing-edit' | 'replace-detected-text'
   */
  popoverTarget: null,

  onPageUpdatedCallback: null,
  activeRenderTask: null
};

/**
 * DOM要素の参照キャッシュ
 */
const dom = {};

/**
 * DOM要素を取得してキャッシュする
 */
function cacheEditorDomElements() {
  dom.modal = document.getElementById('editor-modal');
  dom.pageBadge = document.getElementById('editor-page-badge');
  dom.fileMeta = document.getElementById('editor-file-meta');
  dom.toolDirectTextBtn = document.getElementById('tool-direct-text-btn');
  dom.toolTextBtn = document.getElementById('tool-text-btn');
  dom.toolWhiteoutBtn = document.getElementById('tool-whiteout-btn');
  dom.textFontSelect = document.getElementById('text-font-select');
  dom.textSizeInput = document.getElementById('text-size-input');
  dom.textColorInput = document.getElementById('text-color-input');
  dom.rotateCcwBtn = document.getElementById('modal-rotate-ccw-btn');
  dom.rotateCwBtn = document.getElementById('modal-rotate-cw-btn');
  dom.pageNumOverrideSelect = document.getElementById(
    'modal-pagenum-override-select'
  );
  dom.undoBtn = document.getElementById('modal-undo-btn');
  dom.clearEditsBtn = document.getElementById('modal-clear-edits-btn');
  dom.saveBtn = document.getElementById('modal-save-btn');
  dom.guideText = document.getElementById('editor-guide-text');
  dom.editsCountLabel = document.getElementById('editor-edits-count');
  dom.viewport = document.getElementById('editor-canvas-viewport');
  dom.stage = document.getElementById('editor-canvas-stage');
  dom.pdfCanvas = document.getElementById('editor-pdf-canvas');
  dom.overlayCanvas = document.getElementById('editor-overlay-canvas');
  dom.popover = document.getElementById('text-input-popover');
  dom.popoverTitleText = document.getElementById('popover-title-text');
  dom.popoverTextField = document.getElementById('popover-text-field');
  dom.popoverConfirmBtn = document.getElementById('popover-confirm-btn');
  dom.popoverDeleteTextBtn = document.getElementById('popover-delete-text-btn');
  dom.popoverCancelBtn = document.getElementById('popover-cancel-btn');
}

/**
 * 選択中の編集ツールを切り替える
 * @param {'direct-text' | 'text' | 'whiteout'} toolName - ツール名
 */
function setActiveTool(toolName) {
  editorState.currentTool = toolName;
  hideTextInputPopover();

  dom.toolDirectTextBtn?.classList.toggle('active', toolName === 'direct-text');
  dom.toolTextBtn?.classList.toggle('active', toolName === 'text');
  dom.toolWhiteoutBtn?.classList.toggle('active', toolName === 'whiteout');

  dom.overlayCanvas.classList.remove(
    'mode-direct-text',
    'mode-text',
    'mode-whiteout'
  );

  if (toolName === 'direct-text') {
    dom.overlayCanvas.classList.add('mode-direct-text');
    const detectedCount = editorState.detectedTextItems.length;
    dom.guideText.innerHTML = `
      <i data-lucide="info"></i>
      <span>【テキスト編集モード】検出された既存テキスト枠（${detectedCount}箇所）をクリックして文字の書き換え・削除が可能です。編集後の文字はドラッグで移動できます。</span>
    `;
    preloadJapaneseFont().catch(() => {});
  } else if (toolName === 'text') {
    dom.overlayCanvas.classList.add('mode-text');
    dom.guideText.innerHTML = `
      <i data-lucide="info"></i>
      <span>【新規テキスト追加モード】任意の位置をクリックして文字を追加できます。追加済みの文字はドラッグで位置微調整、クリックで再編集・削除が可能です。</span>
    `;
    preloadJapaneseFont().catch(() => {});
  } else {
    dom.overlayCanvas.classList.add('mode-whiteout');
    dom.guideText.innerHTML = `
      <i data-lucide="info"></i>
      <span>【白塗りモード】ページ上をドラッグすると、選択した矩形領域を白色で塗りつぶします（墨消し・不要箇所の消去）。</span>
    `;
  }

  if (window.lucide) {
    window.lucide.createIcons({ attrs: { class: 'lucide' } });
  }
  redrawOverlayCanvas();
}

/**
 * 履歴操作ボタン（戻す・リセット）および編集件数ラベルを更新する
 */
function updateToolbarState() {
  const edits = editorState.currentPageItem?.edits || [];
  const count = edits.length;

  if (dom.undoBtn) {
    dom.undoBtn.disabled = count === 0;
  }
  if (dom.clearEditsBtn) {
    dom.clearEditsBtn.disabled = count === 0;
  }
  if (dom.editsCountLabel) {
    dom.editsCountLabel.textContent = `編集箇所: ${count}件`;
  }
}

/**
 * PDFキャンバスの対象バウンディングボックス周囲ピクセルから背景色を自動取得（スポイト）する
 * 外れ値（隣接する文字や罫線）の影響を排除するため各RGBチャンネルの中央値（メディアン）を採用する
 *
 * @param {number} maskXRatio - マスク領域左端比率
 * @param {number} maskYRatio - マスク領域上端比率
 * @param {number} maskWRatio - マスク領域幅比率
 * @param {number} maskHRatio - マスク領域高さ比率
 * @returns {string} 16進数カラーコード (例: "#ffffff")
 */
function sampleSurroundingBackgroundColor(
  maskXRatio,
  maskYRatio,
  maskWRatio,
  maskHRatio
) {
  const pdfCanvas = dom.pdfCanvas;
  if (!pdfCanvas || pdfCanvas.width === 0 || pdfCanvas.height === 0) {
    return '#ffffff';
  }

  const ctx = pdfCanvas.getContext('2d');
  const cw = pdfCanvas.width;
  const ch = pdfCanvas.height;

  const rx = Math.max(0, Math.floor(maskXRatio * cw));
  const ry = Math.max(0, Math.floor(maskYRatio * ch));
  const rw = Math.max(2, Math.ceil(maskWRatio * cw));
  const rh = Math.max(2, Math.ceil(maskHRatio * ch));

  // バウンディングボックスの2px外側の枠領域を取得
  const pad = 2;
  const sx = Math.max(0, rx - pad);
  const sy = Math.max(0, ry - pad);
  const ex = Math.min(cw - 1, rx + rw + pad);
  const ey = Math.min(ch - 1, ry + rh + pad);
  const sw = Math.max(1, ex - sx + 1);
  const sh = Math.max(1, ey - sy + 1);

  try {
    const imgData = ctx.getImageData(sx, sy, sw, sh).data;
    const rList = [];
    const gList = [];
    const bList = [];

    // 上辺・下辺・左辺・右辺の外周ピクセルのみをサンプリング
    for (let py = 0; py < sh; py++) {
      for (let px = 0; px < sw; px++) {
        const isBorder =
          py < pad || py >= sh - pad || px < pad || px >= sw - pad;
        if (!isBorder) {
          continue;
        }
        const idx = (py * sw + px) * 4;
        rList.push(imgData[idx]);
        gList.push(imgData[idx + 1]);
        bList.push(imgData[idx + 2]);
      }
    }

    if (rList.length === 0) {
      return '#ffffff';
    }

    rList.sort((a, b) => a - b);
    gList.sort((a, b) => a - b);
    bList.sort((a, b) => a - b);

    const mid = Math.floor(rList.length / 2);
    const toHex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return `#${toHex(rList[mid])}${toHex(gList[mid])}${toHex(bList[mid])}`;
  } catch {
    return '#ffffff';
  }
}

/**
 * 編集要素（text または replace-text）のキャンバス上のバウンディングボックスを算出する
 * @param {object} edit - 編集要素
 * @param {HTMLCanvasElement} canvas - 対象キャンバス
 * @returns {{ x: number, y: number, w: number, h: number } | null}
 */
function getEditTextBoundingBoxOnCanvas(edit, canvas) {
  if (!edit || !canvas) {
    return null;
  }
  if (edit.type !== 'text' && edit.type !== 'replace-text') {
    return null;
  }

  // 文字削除済みの replace-text で文字列が空の場合はマスク領域を返す
  if (edit.type === 'replace-text' && (!edit.text || String(edit.text).length === 0)) {
    return {
      x: (edit.maskXRatio ?? edit.xRatio) * canvas.width,
      y: (edit.maskYRatio ?? edit.yRatio) * canvas.height,
      w: (edit.maskWidthRatio || 0.05) * canvas.width,
      h: (edit.maskHeightRatio || 0.025) * canvas.height
    };
  }

  const scaleFactor =
    editorState.currentPdfPointWidth > 0
      ? canvas.width / editorState.currentPdfPointWidth
      : 1;
  const fontSizePt = Number(edit.fontSizePt) || 14;
  const fontSizePx = Math.max(8, fontSizePt * scaleFactor);

  const ctx = canvas.getContext('2d');
  const cssFont = getCssFontFamily(edit.fontFamily || 'noto-sans');
  ctx.save();
  ctx.font = `500 ${fontSizePx}px ${cssFont}`;
  const textWidth = Math.max(16, ctx.measureText(String(edit.text || '')).width);
  ctx.restore();

  const x = edit.xRatio * canvas.width;
  const y = edit.yRatio * canvas.height;
  return {
    x: x - 2,
    y: y - 2,
    w: textWidth + 6,
    h: fontSizePx * 1.2 + 4
  };
}

/**
 * キャンバス座標 (x, y) にある既存の編集済みテキスト要素（後ろから優先）を検索する
 * @param {number} x - キャンバスX座標
 * @param {number} y - キャンバスY座標
 * @returns {object | null} ヒットした編集要素
 */
function findHitEditTextItem(x, y) {
  const edits = editorState.currentPageItem?.edits || [];
  const canvas = dom.overlayCanvas;
  if (!canvas || edits.length === 0) {
    return null;
  }

  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    if (edit.type === 'text' || edit.type === 'replace-text') {
      const box = getEditTextBoundingBoxOnCanvas(edit, canvas);
      if (
        box &&
        x >= box.x &&
        x <= box.x + box.w &&
        y >= box.y &&
        y <= box.y + box.h
      ) {
        return edit;
      }
    }
  }
  return null;
}

/**
 * キャンバス座標 (x, y) にある pdf.js 検出済みの既存テキスト要素を検索する
 * @param {number} x - キャンバスX座標
 * @param {number} y - キャンバスY座標
 * @returns {object | null} ヒットした検出テキスト要素
 */
function findHitDetectedTextItem(x, y) {
  const canvas = dom.overlayCanvas;
  if (!canvas || editorState.detectedTextItems.length === 0) {
    return null;
  }

  for (let i = editorState.detectedTextItems.length - 1; i >= 0; i--) {
    const item = editorState.detectedTextItems[i];
    const bx = item.maskXRatio * canvas.width;
    const by = item.maskYRatio * canvas.height;
    const bw = item.maskWidthRatio * canvas.width;
    const bh = item.maskHeightRatio * canvas.height;

    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
      return item;
    }
  }
  return null;
}

/**
 * オーバーレイキャンバスを再描画する
 * （確定済み編集 + 既存テキストハイライト枠 + 編集テキスト枠 + 白塗りラバーバンド + 挿入マーカー）
 */
function redrawOverlayCanvas() {
  const canvas = dom.overlayCanvas;
  if (!canvas) {
    return;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const edits = editorState.currentPageItem?.edits || [];

  // 1. 確定済みの白塗り・既存テキスト置換/削除・新規テキストを描画
  renderEditsOnCanvasContext(
    ctx,
    edits,
    canvas.width,
    canvas.height,
    editorState.currentPdfPointWidth
  );

  // 2. ダイレクトテキスト編集モード時：pdf.js で検出した既存テキストのバウンディングボックスをハイライト表示
  if (editorState.currentTool === 'direct-text') {
    const replacedKeys = new Set(
      edits
        .filter((e) => e.type === 'replace-text' && e.targetKey)
        .map((e) => e.targetKey)
    );

    ctx.save();
    for (const item of editorState.detectedTextItems) {
      // すでに置換・削除されたアイテムは個別編集枠として描画するためスキップ
      if (replacedKeys.has(item.key)) {
        continue;
      }

      const bx = item.maskXRatio * canvas.width;
      const by = item.maskYRatio * canvas.height;
      const bw = item.maskWidthRatio * canvas.width;
      const bh = item.maskHeightRatio * canvas.height;
      const isHovered = editorState.hoveredDetectedItemKey === item.key;

      ctx.fillStyle = isHovered
        ? 'rgba(37, 99, 235, 0.18)'
        : 'rgba(59, 130, 246, 0.07)';
      ctx.fillRect(bx, by, bw, bh);

      ctx.strokeStyle = isHovered
        ? 'rgba(29, 78, 216, 0.95)'
        : 'rgba(37, 99, 235, 0.48)';
      ctx.lineWidth = isHovered ? 2 : 1;
      ctx.setLineDash(isHovered ? [] : [3, 2]);
      ctx.strokeRect(bx, by, bw, bh);
    }
    ctx.restore();
  }

  // 3. 編集済み要素（白塗り・追加テキスト・置換テキスト）の視覚ガイド枠を描画
  ctx.save();
  for (const edit of edits) {
    if (edit.type === 'whiteout') {
      const x = edit.xRatio * canvas.width;
      const y = edit.yRatio * canvas.height;
      const w = edit.widthRatio * canvas.width;
      const h = edit.heightRatio * canvas.height;
      ctx.strokeStyle = 'rgba(100, 116, 139, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x, y, w, h);
    } else if (edit.type === 'text' || edit.type === 'replace-text') {
      const box = getEditTextBoundingBoxOnCanvas(edit, canvas);
      if (box) {
        const isHovered =
          editorState.hoveredEditId === edit.id ||
          editorState.draggingEditItem?.id === edit.id;
        ctx.strokeStyle = isHovered
          ? '#d97706'
          : 'rgba(217, 119, 6, 0.65)';
        ctx.lineWidth = isHovered ? 2 : 1.2;
        ctx.setLineDash([4, 2]);
        ctx.strokeRect(box.x, box.y, box.w, box.h);
      }
    }
  }
  ctx.restore();

  // 4. 白塗りドラッグ中のラバーバンド矩形プレビューを描画
  if (editorState.isDraggingWhiteout && editorState.currentTool === 'whiteout') {
    const rectX = Math.min(editorState.dragStartX, editorState.dragCurrentX);
    const rectY = Math.min(editorState.dragStartY, editorState.dragCurrentY);
    const rectW = Math.abs(editorState.dragCurrentX - editorState.dragStartX);
    const rectH = Math.abs(editorState.dragCurrentY - editorState.dragStartY);

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillRect(rectX, rectY, rectW, rectH);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(rectX, rectY, rectW, rectH);
    ctx.restore();
  }

  // 5. ポップオーバー表示中のターゲットマーカーを描画
  if (editorState.popoverTarget) {
    const { canvasX, canvasY } = editorState.popoverTarget;
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(canvasX, canvasY, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * テキスト編集・追加用ポップオーバーを表示する
 * @param {object} targetConfig - ターゲット設定
 */
function openTextPopover(targetConfig) {
  const canvas = dom.overlayCanvas;
  if (!canvas || !dom.popover) {
    return;
  }

  editorState.popoverTarget = targetConfig;

  if (dom.popoverTitleText) {
    if (targetConfig.mode === 'replace-detected-text') {
      dom.popoverTitleText.textContent = '既存テキストの書き換え・削除';
    } else if (targetConfig.mode === 'edit-existing-edit') {
      dom.popoverTitleText.textContent = 'テキストの再編集・削除';
    } else {
      dom.popoverTitleText.textContent = '新規テキストを追記';
    }
  }

  // 既存文字編集または再編集時は「文字削除」ボタンを表示
  if (dom.popoverDeleteTextBtn) {
    const showDelete =
      targetConfig.mode === 'replace-detected-text' ||
      targetConfig.mode === 'edit-existing-edit';
    dom.popoverDeleteTextBtn.classList.toggle('hidden', !showDelete);
  }

  // フォント・サイズ・色の同期
  if (targetConfig.fontFamily && dom.textFontSelect) {
    dom.textFontSelect.value = targetConfig.fontFamily;
  }
  if (targetConfig.fontSizePt && dom.textSizeInput) {
    dom.textSizeInput.value = String(Math.round(targetConfig.fontSizePt));
  }
  if (targetConfig.color && dom.textColorInput) {
    dom.textColorInput.value = targetConfig.color;
  }

  // ポップオーバーの表示座標を計算
  const popoverWidth = 340;
  const popoverHeight = 115;
  const left = Math.max(
    8,
    Math.min(canvas.width - popoverWidth - 8, targetConfig.canvasX)
  );
  const top =
    targetConfig.canvasY + popoverHeight + 28 < canvas.height
      ? targetConfig.canvasY + 14
      : Math.max(8, targetConfig.canvasY - popoverHeight - 10);

  dom.popover.style.left = `${left}px`;
  dom.popover.style.top = `${top}px`;
  dom.popover.classList.remove('hidden');

  if (dom.popoverTextField) {
    dom.popoverTextField.value = targetConfig.initialText ?? '';
    setTimeout(() => {
      dom.popoverTextField.focus();
      dom.popoverTextField.select();
    }, 20);
  }

  redrawOverlayCanvas();
}

/**
 * テキスト入力用ポップオーバーを非表示にする
 */
function hideTextInputPopover() {
  editorState.popoverTarget = null;
  if (dom.popover) {
    dom.popover.classList.add('hidden');
  }
  if (dom.popoverTextField) {
    dom.popoverTextField.value = '';
  }
  redrawOverlayCanvas();
}

/**
 * ポップオーバーでの編集・追加を確定する
 */
function confirmPopoverTextAction() {
  const target = editorState.popoverTarget;
  const pageItem = editorState.currentPageItem;
  if (!target || !pageItem) {
    hideTextInputPopover();
    return;
  }

  if (!Array.isArray(pageItem.edits)) {
    pageItem.edits = [];
  }

  const inputText = dom.popoverTextField ? dom.popoverTextField.value : '';
  const fontFamily =
    dom.textFontSelect?.value || target.fontFamily || 'noto-sans';
  const fontSizePt = Math.max(
    6,
    Math.min(120, Number(dom.textSizeInput?.value) || target.fontSizePt || 14)
  );
  const color = dom.textColorInput?.value || '#000000';

  // 選択されたフォントをバックグラウンドでプリロード開始
  preloadJapaneseFont(fontFamily).catch(() => {});

  if (target.mode === 'replace-detected-text') {
    const det = target.detectedItem;
    // 周囲ピクセルから背景色を自動取得
    const bgColor = sampleSurroundingBackgroundColor(
      det.maskXRatio,
      det.maskYRatio,
      det.maskWidthRatio,
      det.maskHeightRatio
    );

    pageItem.edits.push({
      id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'replace-text',
      targetKey: det.key,
      originalText: det.originalText,
      text: inputText, // 空文字の場合は元の文字の削除（マスクのみ）として機能する
      xRatio: det.xRatio,
      yRatio: det.yRatio,
      maskXRatio: det.maskXRatio,
      maskYRatio: det.maskYRatio,
      maskWidthRatio: det.maskWidthRatio,
      maskHeightRatio: det.maskHeightRatio,
      bgColor,
      fontFamily,
      fontSizePt,
      color
    });
  } else if (target.mode === 'edit-existing-edit') {
    const existingEdit = pageItem.edits.find((e) => e.id === target.editId);
    if (existingEdit) {
      if (existingEdit.type === 'text' && !inputText.trim()) {
        // 新規追加テキストが空にされた場合は要素自体を削除
        const idx = pageItem.edits.indexOf(existingEdit);
        if (idx !== -1) {
          pageItem.edits.splice(idx, 1);
        }
      } else {
        existingEdit.text = inputText;
        existingEdit.fontFamily = fontFamily;
        existingEdit.fontSizePt = fontSizePt;
        existingEdit.color = color;
      }
    }
  } else if (target.mode === 'new-text') {
    if (inputText.trim().length > 0) {
      pageItem.edits.push({
        id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'text',
        xRatio: target.xRatio,
        yRatio: target.yRatio,
        text: inputText.trim(),
        fontFamily,
        fontSizePt,
        color
      });
    }
  }

  hideTextInputPopover();
  updateToolbarState();
  redrawOverlayCanvas();
}

/**
 * ポップオーバーの「文字削除」ボタンが押されたときの処理
 * 既存テキストの場合は背景色マスクで元文字を完全に消去し、新規追加テキストの場合は要素を削除する
 */
function handleDeleteTextFromPopover() {
  const target = editorState.popoverTarget;
  const pageItem = editorState.currentPageItem;
  if (!target || !pageItem) {
    hideTextInputPopover();
    return;
  }

  if (!Array.isArray(pageItem.edits)) {
    pageItem.edits = [];
  }

  if (target.mode === 'replace-detected-text') {
    const det = target.detectedItem;
    const bgColor = sampleSurroundingBackgroundColor(
      det.maskXRatio,
      det.maskYRatio,
      det.maskWidthRatio,
      det.maskHeightRatio
    );

    pageItem.edits.push({
      id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'replace-text',
      targetKey: det.key,
      originalText: det.originalText,
      text: '', // 空文字＝元文字の削除（マスクのみ）
      xRatio: det.xRatio,
      yRatio: det.yRatio,
      maskXRatio: det.maskXRatio,
      maskYRatio: det.maskYRatio,
      maskWidthRatio: det.maskWidthRatio,
      maskHeightRatio: det.maskHeightRatio,
      bgColor,
      fontSizePt: det.fontSizePt || 12,
      color: '#000000'
    });
  } else if (target.mode === 'edit-existing-edit') {
    const existingEdit = pageItem.edits.find((e) => e.id === target.editId);
    if (existingEdit) {
      if (existingEdit.type === 'replace-text') {
        // 既存テキスト置換の場合は文字を空にして元文字マスク状態を維持
        existingEdit.text = '';
      } else {
        // 新規追加テキストの場合はリストから除去
        const idx = pageItem.edits.indexOf(existingEdit);
        if (idx !== -1) {
          pageItem.edits.splice(idx, 1);
        }
      }
    }
  }

  hideTextInputPopover();
  updateToolbarState();
  redrawOverlayCanvas();
}

/**
 * ポインターイベントからキャンバス内部の正確なピクセル座標 (x, y) を算出する
 * @param {PointerEvent | MouseEvent} event - イベント
 * @returns {{ x: number, y: number }}
 */
function getCanvasCoordinates(event) {
  const canvas = dom.overlayCanvas;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / (rect.width || 1);
  const scaleY = canvas.height / (rect.height || 1);
  const x = Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * scaleX));
  const y = Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * scaleY));
  return { x, y };
}

/**
 * pdf.js の page.getTextContent() を使用してページ内の既存テキスト要素とバウンディングボックスを抽出する
 * @param {object} pdfPage - pdf.js の PDFPageProxy
 * @param {object} viewport - 現在の描画 PageViewport
 * @param {number} canvasWidth - キャンバス幅
 * @param {number} canvasHeight - キャンバス高さ
 * @returns {Promise<Array<object>>} 抽出されたテキストアイテム配列
 */
async function extractPdfPageTextItems(
  pdfPage,
  viewport,
  canvasWidth,
  canvasHeight
) {
  if (!pdfPage || typeof pdfPage.getTextContent !== 'function') {
    return [];
  }

  try {
    const textContent = await pdfPage.getTextContent();
    const Util = window.pdfjsLib?.Util;
    if (!textContent || !Array.isArray(textContent.items) || !Util) {
      return [];
    }

    const extracted = [];
    textContent.items.forEach((item, index) => {
      const str = item.str;
      if (!str || !str.trim()) {
        return;
      }

      // ビューポート変換行列とテキストアイテムの変換行列を合成
      const tx = Util.transform(viewport.transform, item.transform);
      const fontHeightPx = Math.max(6, Math.hypot(tx[2], tx[3]));
      const fontSizePt = Math.max(
        6,
        Math.round((fontHeightPx / (viewport.scale || 1)) * 10) / 10
      );

      // アイテムのピクセル幅を計算
      const rawItemWidthPx = (item.width || 0) * (viewport.scale || 1);
      const estimatedWidthPx = Math.max(
        fontHeightPx * 0.6,
        rawItemWidthPx > 2 ? rawItemWidthPx : str.length * fontHeightPx * 0.65
      );

      const baseX = tx[4];
      const baseY = tx[5];

      // テキストの上端 (top) とマスク用バウンディングボックス
      const topY = baseY - fontHeightPx * 0.84;
      const maskX = baseX - 2;
      const maskY = baseY - fontHeightPx * 0.92;
      const maskW = estimatedWidthPx + 4;
      const maskH = fontHeightPx * 1.18;

      extracted.push({
        key: `det_${index}_${Math.round(baseX)}_${Math.round(baseY)}`,
        originalText: str,
        xRatio: Math.max(0, Math.min(0.99, baseX / canvasWidth)),
        yRatio: Math.max(0, Math.min(0.99, topY / canvasHeight)),
        maskXRatio: Math.max(0, Math.min(0.99, maskX / canvasWidth)),
        maskYRatio: Math.max(0, Math.min(0.99, maskY / canvasHeight)),
        maskWidthRatio: Math.max(0.005, Math.min(1, maskW / canvasWidth)),
        maskHeightRatio: Math.max(0.005, Math.min(1, maskH / canvasHeight)),
        fontSizePt
      });
    });

    return extracted;
  } catch (error) {
    console.warn('既存テキストの抽出に失敗しました:', error);
    return [];
  }
}

/**
 * モーダル内の高解像度PDFキャンバスを描画し、既存テキスト要素を検出する
 */
async function renderEditorPdfPage() {
  const pageItem = editorState.currentPageItem;
  const pdfJsDoc = editorState.currentPdfJsDoc;
  if (!pageItem || !dom.pdfCanvas || !dom.overlayCanvas) {
    return;
  }

  if (editorState.activeRenderTask) {
    try {
      editorState.activeRenderTask.cancel();
    } catch {
      // キャンセル例外は無視
    }
    editorState.activeRenderTask = null;
  }

  const availableWidth = Math.max(320, (dom.viewport?.clientWidth || 880) - 64);
  const targetWidth = Math.min(840, availableWidth);

  // 空白ページ (type === 'blank') の場合
  if (pageItem.type === 'blank') {
    const { width: viewW, height: viewH } = getEffectivePageDimensions(pageItem);
    editorState.currentPdfPointWidth = viewW;
    editorState.currentPdfPointHeight = viewH;
    editorState.detectedTextItems = [];

    const scale = Math.min(1.6, Math.max(0.8, targetWidth / (viewW || 595.28)));
    const width = Math.max(1, Math.floor(viewW * scale));
    const height = Math.max(1, Math.floor(viewH * scale));

    dom.pdfCanvas.width = width;
    dom.pdfCanvas.height = height;
    dom.overlayCanvas.width = width;
    dom.overlayCanvas.height = height;

    const pdfCtx = dom.pdfCanvas.getContext('2d', { alpha: false });
    pdfCtx.fillStyle = '#ffffff';
    pdfCtx.fillRect(0, 0, width, height);

    setActiveTool(editorState.currentTool);
    redrawOverlayCanvas();
    return;
  }

  if (!pdfJsDoc) {
    return;
  }

  const pdfPage = await pdfJsDoc.getPage(pageItem.pageIndex + 1);
  const baseRotation = pdfPage.rotate || 0;
  const userRotation = pageItem.rotation || 0;
  const totalRotation = normalizeRotation(baseRotation + userRotation);

  const unscaledViewport = pdfPage.getViewport({
    scale: 1.0,
    rotation: totalRotation
  });
  editorState.currentPdfPointWidth = unscaledViewport.width || 595.28;
  editorState.currentPdfPointHeight = unscaledViewport.height || 841.89;

  const scale = Math.min(
    1.6,
    Math.max(0.8, targetWidth / (unscaledViewport.width || 600))
  );

  const viewport = pdfPage.getViewport({
    scale,
    rotation: totalRotation
  });

  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));

  dom.pdfCanvas.width = width;
  dom.pdfCanvas.height = height;
  dom.overlayCanvas.width = width;
  dom.overlayCanvas.height = height;

  const pdfCtx = dom.pdfCanvas.getContext('2d', { alpha: false });
  pdfCtx.fillStyle = '#ffffff';
  pdfCtx.fillRect(0, 0, width, height);

  const renderTask = pdfPage.render({
    canvasContext: pdfCtx,
    viewport
  });
  editorState.activeRenderTask = renderTask;

  try {
    await renderTask.promise;
  } catch (error) {
    if (error && error.name === 'RenderingCancelledException') {
      return;
    }
    console.error('編集モーダルのページ描画エラー:', error);
  } finally {
    if (editorState.activeRenderTask === renderTask) {
      editorState.activeRenderTask = null;
    }
  }

  // pdf.js の getTextContent() でページ内の既存テキスト要素を検出
  editorState.detectedTextItems = await extractPdfPageTextItems(
    pdfPage,
    viewport,
    width,
    height
  );

  setActiveTool(editorState.currentTool);
  redrawOverlayCanvas();
}

/**
 * エディタモーダルのイベントリスナーを初期化する（初回1回のみ実行）
 */
export function initPageEditor() {
  if (editorState.isInitialized) {
    return;
  }
  cacheEditorDomElements();
  if (!dom.modal || !dom.overlayCanvas) {
    return;
  }

  // ツール切替ボタン
  dom.toolDirectTextBtn?.addEventListener('click', () =>
    setActiveTool('direct-text')
  );
  dom.toolTextBtn?.addEventListener('click', () => setActiveTool('text'));
  dom.toolWhiteoutBtn?.addEventListener('click', () =>
    setActiveTool('whiteout')
  );

  // 左へ90度回転（反時計回り / -90°）ボタン
  dom.rotateCcwBtn?.addEventListener('click', async () => {
    const pageItem = editorState.currentPageItem;
    if (!pageItem) {
      return;
    }
    hideTextInputPopover();
    pageItem.rotation = normalizeRotation((pageItem.rotation || 0) - 90);
    if (Array.isArray(pageItem.edits) && pageItem.edits.length > 0) {
      pageItem.edits = rotateEditsCounterClockwise90(pageItem.edits);
    }
    await renderEditorPdfPage();
  });

  // 右へ90度回転（時計回り / +90°）ボタン
  dom.rotateCwBtn?.addEventListener('click', async () => {
    const pageItem = editorState.currentPageItem;
    if (!pageItem) {
      return;
    }
    hideTextInputPopover();
    pageItem.rotation = normalizeRotation((pageItem.rotation || 0) + 90);
    if (Array.isArray(pageItem.edits) && pageItem.edits.length > 0) {
      pageItem.edits = rotateEditsClockwise90(pageItem.edits);
    }
    await renderEditorPdfPage();
  });

  // モーダル内のページ番号個別オーバーライド設定
  dom.pageNumOverrideSelect?.addEventListener('change', (event) => {
    const pageItem = editorState.currentPageItem;
    if (!pageItem) {
      return;
    }
    pageItem.pageNumberOverride = event.target.value || 'inherit';
  });

  // 1つ元に戻す (Undo) ボタン
  dom.undoBtn?.addEventListener('click', () => {
    const pageItem = editorState.currentPageItem;
    if (
      !pageItem ||
      !Array.isArray(pageItem.edits) ||
      pageItem.edits.length === 0
    ) {
      return;
    }
    hideTextInputPopover();
    pageItem.edits.pop();
    updateToolbarState();
    redrawOverlayCanvas();
  });

  // 編集リセットボタン
  dom.clearEditsBtn?.addEventListener('click', () => {
    const pageItem = editorState.currentPageItem;
    if (
      !pageItem ||
      !Array.isArray(pageItem.edits) ||
      pageItem.edits.length === 0
    ) {
      return;
    }
    hideTextInputPopover();
    pageItem.edits = [];
    updateToolbarState();
    redrawOverlayCanvas();
  });

  // 完了して閉じるボタン
  dom.saveBtn?.addEventListener('click', () => {
    closePageEditorModal();
  });

  // モーダル背景クリックで閉じる
  dom.modal.addEventListener('click', (event) => {
    if (event.target === dom.modal) {
      closePageEditorModal();
    }
  });

  // Escape キーでポップオーバーまたはモーダルを閉じる
  window.addEventListener('keydown', (event) => {
    if (!editorState.isOpen) {
      return;
    }
    if (event.key === 'Escape') {
      if (editorState.popoverTarget) {
        hideTextInputPopover();
      } else {
        closePageEditorModal();
      }
    }
  });

  // オーバーレイキャンバス上のポインターダウン
  dom.overlayCanvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    const { x, y } = getCanvasCoordinates(event);

    // 白塗りモード時
    if (editorState.currentTool === 'whiteout') {
      hideTextInputPopover();
      editorState.isDraggingWhiteout = true;
      editorState.dragStartX = x;
      editorState.dragStartY = y;
      editorState.dragCurrentX = x;
      editorState.dragCurrentY = y;
      dom.overlayCanvas.setPointerCapture(event.pointerId);
      redrawOverlayCanvas();
      return;
    }

    // 1. まず既に追加・編集済みのテキスト要素の上を押したか判定（ドラッグ移動または再編集）
    const hitEdit = findHitEditTextItem(x, y);
    if (hitEdit) {
      hideTextInputPopover();
      editorState.draggingEditItem = hitEdit;
      editorState.dragEditStartCanvasX = x;
      editorState.dragEditStartCanvasY = y;
      editorState.dragEditInitialXRatio = hitEdit.xRatio;
      editorState.dragEditInitialYRatio = hitEdit.yRatio;
      editorState.hasMovedDuringTextDrag = false;
      dom.overlayCanvas.setPointerCapture(event.pointerId);
      redrawOverlayCanvas();
      return;
    }

    // 2. ダイレクトテキスト編集モード時：検出された既存テキスト枠をクリックしたか判定
    if (editorState.currentTool === 'direct-text') {
      const hitDetected = findHitDetectedTextItem(x, y);
      if (hitDetected) {
        openTextPopover({
          mode: 'replace-detected-text',
          detectedItem: hitDetected,
          initialText: hitDetected.originalText,
          fontSizePt: hitDetected.fontSizePt,
          color: dom.textColorInput?.value || '#000000',
          canvasX: hitDetected.maskXRatio * dom.overlayCanvas.width,
          canvasY: hitDetected.maskYRatio * dom.overlayCanvas.height
        });
        return;
      }
    }

    // 3. 新規テキスト追加モード（またはダイレクト編集モードで余白をクリックした場合）：新規テキスト追加ポップオーバーを表示
    openTextPopover({
      mode: 'new-text',
      initialText: '',
      fontSizePt: Number(dom.textSizeInput?.value) || 16,
      color: dom.textColorInput?.value || '#000000',
      xRatio: Math.max(0, Math.min(0.98, x / dom.overlayCanvas.width)),
      yRatio: Math.max(0, Math.min(0.98, y / dom.overlayCanvas.height)),
      canvasX: x,
      canvasY: y
    });
  });

  // ポインタームーブ（ドラッグ移動・白塗りプレビュー・ホバーハイライト）
  dom.overlayCanvas.addEventListener('pointermove', (event) => {
    const { x, y } = getCanvasCoordinates(event);

    // 既存/新規テキスト要素のドラッグ位置微調整中
    if (editorState.draggingEditItem) {
      const dx = x - editorState.dragEditStartCanvasX;
      const dy = y - editorState.dragEditStartCanvasY;
      if (Math.hypot(dx, dy) >= 3) {
        editorState.hasMovedDuringTextDrag = true;
      }
      if (editorState.hasMovedDuringTextDrag) {
        const canvas = dom.overlayCanvas;
        editorState.draggingEditItem.xRatio = Math.max(
          0,
          Math.min(0.98, editorState.dragEditInitialXRatio + dx / canvas.width)
        );
        editorState.draggingEditItem.yRatio = Math.max(
          0,
          Math.min(0.98, editorState.dragEditInitialYRatio + dy / canvas.height)
        );
        redrawOverlayCanvas();
      }
      return;
    }

    // 白塗りドラッグ中
    if (
      editorState.isDraggingWhiteout &&
      editorState.currentTool === 'whiteout'
    ) {
      editorState.dragCurrentX = x;
      editorState.dragCurrentY = y;
      redrawOverlayCanvas();
      return;
    }

    // ホバー状態の更新
    const hitEdit = findHitEditTextItem(x, y);
    const newHoveredEditId = hitEdit ? hitEdit.id : null;

    let newHoveredDetectedKey = null;
    if (!hitEdit && editorState.currentTool === 'direct-text') {
      const hitDet = findHitDetectedTextItem(x, y);
      if (hitDet) {
        newHoveredDetectedKey = hitDet.key;
      }
    }

    if (
      newHoveredEditId !== editorState.hoveredEditId ||
      newHoveredDetectedKey !== editorState.hoveredDetectedItemKey
    ) {
      editorState.hoveredEditId = newHoveredEditId;
      editorState.hoveredDetectedItemKey = newHoveredDetectedKey;
      redrawOverlayCanvas();
    }
  });

  // ポインターアップ（ドラッグ完了・クリック再編集確定）
  const finishPointerInteraction = (event) => {
    // 1. テキスト要素のドラッグまたはクリック完了
    if (editorState.draggingEditItem) {
      const targetEdit = editorState.draggingEditItem;
      const moved = editorState.hasMovedDuringTextDrag;
      editorState.draggingEditItem = null;
      editorState.hasMovedDuringTextDrag = false;
      try {
        dom.overlayCanvas.releasePointerCapture(event.pointerId);
      } catch {
        // 無視
      }

      if (!moved) {
        // ドラッグせずにクリックした場合は再編集ポップオーバーを開く
        openTextPopover({
          mode: 'edit-existing-edit',
          editId: targetEdit.id,
          initialText: targetEdit.text || '',
          fontFamily: targetEdit.fontFamily || 'noto-sans',
          fontSizePt: targetEdit.fontSizePt || 16,
          color: targetEdit.color || '#000000',
          canvasX: targetEdit.xRatio * dom.overlayCanvas.width,
          canvasY: targetEdit.yRatio * dom.overlayCanvas.height
        });
      } else {
        redrawOverlayCanvas();
      }
      return;
    }

    // 2. 白塗りドラッグ完了
    if (
      editorState.isDraggingWhiteout &&
      editorState.currentTool === 'whiteout'
    ) {
      editorState.isDraggingWhiteout = false;
      try {
        dom.overlayCanvas.releasePointerCapture(event.pointerId);
      } catch {
        // 無視
      }

      const canvas = dom.overlayCanvas;
      const rectX = Math.min(editorState.dragStartX, editorState.dragCurrentX);
      const rectY = Math.min(editorState.dragStartY, editorState.dragCurrentY);
      const rectW = Math.abs(editorState.dragCurrentX - editorState.dragStartX);
      const rectH = Math.abs(editorState.dragCurrentY - editorState.dragStartY);

      if (rectW >= 4 && rectH >= 4 && editorState.currentPageItem) {
        if (!Array.isArray(editorState.currentPageItem.edits)) {
          editorState.currentPageItem.edits = [];
        }
        editorState.currentPageItem.edits.push({
          id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: 'whiteout',
          xRatio: rectX / canvas.width,
          yRatio: rectY / canvas.height,
          widthRatio: rectW / canvas.width,
          heightRatio: rectH / canvas.height,
          bgColor: '#ffffff'
        });
        updateToolbarState();
      }

      redrawOverlayCanvas();
    }
  };

  dom.overlayCanvas.addEventListener('pointerup', finishPointerInteraction);
  dom.overlayCanvas.addEventListener('pointercancel', finishPointerInteraction);

  // ポップオーバーのイベント
  dom.popoverConfirmBtn?.addEventListener('click', () => {
    confirmPopoverTextAction();
  });

  dom.popoverDeleteTextBtn?.addEventListener('click', () => {
    handleDeleteTextFromPopover();
  });

  dom.popoverCancelBtn?.addEventListener('click', () => {
    hideTextInputPopover();
  });

  dom.popoverTextField?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      confirmPopoverTextAction();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideTextInputPopover();
    }
  });

  editorState.isInitialized = true;
}

/**
 * 指定ページの拡大編集モーダルを開く
 *
 * @param {object} pageItem - 編集対象のページ状態オブジェクト
 * @param {number} orderIndex - 現在の並び順インデックス (0始まり)
 * @param {object | null} pdfJsDoc - pdf.js の PDFDocumentProxy（空白ページの場合は null 可）
 * @param {(pageId: string) => void} onPageUpdated - モーダル終了時にサムネイル等を再描画するコールバック
 */
export async function openPageEditorModal(
  pageItem,
  orderIndex,
  pdfJsDoc,
  onPageUpdated
) {
  initPageEditor();
  if (!dom.modal || !pageItem) {
    return;
  }

  editorState.isOpen = true;
  editorState.currentPageItem = pageItem;
  editorState.currentOrderIndex = orderIndex;
  editorState.currentPdfJsDoc = pdfJsDoc || null;
  editorState.onPageUpdatedCallback = onPageUpdated || null;

  if (!Array.isArray(pageItem.edits)) {
    pageItem.edits = [];
  }

  // ヘッダー情報の更新
  if (dom.pageBadge) {
    dom.pageBadge.textContent = `#${orderIndex + 1}`;
  }
  if (dom.fileMeta) {
    if (pageItem.type === 'blank') {
      dom.fileMeta.textContent = `${pageItem.fileName} (${pageItem.paperLabel || '白紙'})`;
    } else {
      dom.fileMeta.textContent = `${pageItem.fileName} (元ページ: P.${pageItem.pageIndex + 1})`;
    }
    dom.fileMeta.title = dom.fileMeta.textContent;
  }

  if (dom.pageNumOverrideSelect) {
    dom.pageNumOverrideSelect.value = pageItem.pageNumberOverride || 'inherit';
  }

  hideTextInputPopover();
  updateToolbarState();

  // 空白ページの場合は新規テキストモードを初期選択、PDFページの場合はダイレクトテキスト編集を初期選択
  const initialTool =
    pageItem.type === 'blank' && editorState.currentTool === 'direct-text'
      ? 'text'
      : editorState.currentTool || 'direct-text';
  setActiveTool(initialTool);

  dom.modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  preloadJapaneseFont().catch(() => {});

  await renderEditorPdfPage();
}

/**
 * ページ拡大編集モーダルを閉じ、変更をサムネイル一覧へ反映する
 */
export function closePageEditorModal() {
  if (!editorState.isOpen) {
    return;
  }

  hideTextInputPopover();

  const updatedPageId = editorState.currentPageItem?.id;
  const callback = editorState.onPageUpdatedCallback;

  editorState.isOpen = false;
  editorState.currentPageItem = null;
  editorState.currentPdfJsDoc = null;
  editorState.onPageUpdatedCallback = null;

  if (dom.modal) {
    dom.modal.classList.add('hidden');
  }
  document.body.style.overflow = '';

  if (updatedPageId && typeof callback === 'function') {
    callback(updatedPageId);
  }
}
