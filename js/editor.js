/**
 * @file editor.js
 * @description ページ拡大モーダル画面でのダイレクトテキスト編集（pdf.js getTextContentによる既存文字検出・削除・置換）、
 * 新規テキスト追加・ドラッグ位置微調整、図形（□ 四角形・〇 丸/楕円・△・✓・×・―）追加・リサイズ、
 * 画像ファイル（.png / .jpeg 等）貼り付け・リサイズ、白塗り矩形描画、左右回転、ページ番号個別設定モジュール
 */

import {
  preloadJapaneseFont,
  getCssFontFamily,
  normalizeRotation,
  getEffectivePageDimensions,
  rotateEditsClockwise90,
  rotateEditsCounterClockwise90,
  loadImageFileForEditor,
  getCachedImageElement
} from './pdf-engine.js';
import {
  renderEditsOnCanvasContext,
  drawShapeOnCanvasContext
} from './preview.js';

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
  currentTool: 'direct-text', // 'direct-text' | 'text' | 'shape' | 'image' | 'whiteout'

  /**
   * pdf.js の getTextContent() から検出されたページ内の既存テキスト要素リスト
   */
  detectedTextItems: [],

  // 現在選択中の編集要素ID（図形・画像・テキスト・白塗り）
  selectedEditId: null,

  // 白塗りまたは新規図形のドラッグ描画用
  isDraggingWhiteout: false,
  isDraggingShape: false,
  dragStartX: 0,
  dragStartY: 0,
  dragCurrentX: 0,
  dragCurrentY: 0,
  isShiftPressedDuringDrag: false,

  // 編集要素（テキスト・図形・画像・白塗り）のドラッグ移動用
  draggingEditItem: null,
  dragEditStartCanvasX: 0,
  dragEditStartCanvasY: 0,
  dragEditInitialXRatio: 0,
  dragEditInitialYRatio: 0,
  hasMovedDuringEditDrag: false,

  // 図形・画像・白塗り要素の8方向リサイズハンドル操作用
  resizingEditItem: null,
  resizeHandleName: null, // 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
  resizeStartCanvasX: 0,
  resizeStartCanvasY: 0,
  resizeInitialBox: null, // { xRatio, yRatio, widthRatio, heightRatio, aspectPx }

  // 画像モードでキャンバスをクリックしてファイル選択を開いた際の配置目標座標
  pendingImagePointRatio: null,

  // ホバー中の既存テキスト枠・編集要素・リサイズハンドル
  hoveredDetectedItemKey: null,
  hoveredEditId: null,
  hoveredResizeHandle: null,

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

  // ツール切替ボタン
  dom.toolDirectTextBtn = document.getElementById('tool-direct-text-btn');
  dom.toolTextBtn = document.getElementById('tool-text-btn');
  dom.toolShapeBtn = document.getElementById('tool-shape-btn');
  dom.toolImageBtn = document.getElementById('tool-image-btn');
  dom.toolWhiteoutBtn = document.getElementById('tool-whiteout-btn');

  // テキスト設定オプション
  dom.textToolOptions = document.getElementById('text-tool-options');
  dom.textFontSelect = document.getElementById('text-font-select');
  dom.textSizeInput = document.getElementById('text-size-input');
  dom.textColorInput = document.getElementById('text-color-input');

  // 図形設定オプション
  dom.shapeToolOptions = document.getElementById('shape-tool-options');
  dom.shapeQuickBtns = Array.from(
    document.querySelectorAll('.shape-quick-btn[data-shape]')
  );
  dom.shapeTypeSelect = document.getElementById('shape-type-select');
  dom.shapeStrokeWidthInput = document.getElementById(
    'shape-stroke-width-input'
  );
  dom.shapeStrokeColorInput = document.getElementById(
    'shape-stroke-color-input'
  );
  dom.shapeFillEnabledInput = document.getElementById(
    'shape-fill-enabled-input'
  );
  dom.shapeFillColorInput = document.getElementById('shape-fill-color-input');

  // 画像設定オプション
  dom.imageToolOptions = document.getElementById('image-tool-options');
  dom.imageFileInput = document.getElementById('editor-image-input');
  dom.imageUploadBtn = document.getElementById('image-upload-btn');
  dom.imageLockAspectInput = document.getElementById('image-lock-aspect-input');

  // 回転・ページ番号・削除・履歴操作
  dom.rotateCcwBtn = document.getElementById('modal-rotate-ccw-btn');
  dom.rotateCwBtn = document.getElementById('modal-rotate-cw-btn');
  dom.pageNumOverrideSelect = document.getElementById(
    'modal-pagenum-override-select'
  );
  dom.deleteSelectedBtn = document.getElementById('modal-delete-selected-btn');
  dom.undoBtn = document.getElementById('modal-undo-btn');
  dom.clearEditsBtn = document.getElementById('modal-clear-edits-btn');
  dom.saveBtn = document.getElementById('modal-save-btn');

  // ガイド・キャンバス・ポップオーバー
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
 * 現在選択中の編集要素オブジェクトを取得する
 * @returns {object | null}
 */
function getSelectedEditItem() {
  if (!editorState.selectedEditId || !editorState.currentPageItem?.edits) {
    return null;
  }
  return (
    editorState.currentPageItem.edits.find(
      (e) => e.id === editorState.selectedEditId
    ) || null
  );
}

/**
 * 図形クイックボタンのアクティブ表示をセレクトボックスの値と同期する
 * @param {string} shapeType - 'rect' | 'circle' | 'triangle' | 'check' | 'cross' | 'line'
 */
function syncShapeQuickButtons(shapeType) {
  if (dom.shapeTypeSelect && dom.shapeTypeSelect.value !== shapeType) {
    dom.shapeTypeSelect.value = shapeType;
  }
  if (dom.shapeQuickBtns) {
    for (const btn of dom.shapeQuickBtns) {
      btn.classList.toggle('active', btn.dataset.shape === shapeType);
    }
  }
}

/**
 * 選択された編集要素のプロパティをツールバーの入力コントロールへ反映する
 * @param {object | null} edit - 選択された編集要素
 */
function syncToolbarOptionsFromSelectedEdit(edit) {
  if (!edit) {
    return;
  }
  if (edit.type === 'shape') {
    syncShapeQuickButtons(edit.shapeType || 'rect');
    if (dom.shapeStrokeWidthInput) {
      dom.shapeStrokeWidthInput.value = String(edit.strokeWidthPt || 2);
    }
    if (dom.shapeStrokeColorInput) {
      dom.shapeStrokeColorInput.value = edit.strokeColor || '#000000';
    }
    if (dom.shapeFillEnabledInput) {
      dom.shapeFillEnabledInput.checked = Boolean(edit.fillEnabled);
    }
    if (dom.shapeFillColorInput) {
      dom.shapeFillColorInput.value = edit.fillColor || '#ffffff';
    }
  } else if (edit.type === 'text' || edit.type === 'replace-text') {
    if (edit.fontFamily && dom.textFontSelect) {
      dom.textFontSelect.value = edit.fontFamily;
    }
    if (edit.fontSizePt && dom.textSizeInput) {
      dom.textSizeInput.value = String(Math.round(edit.fontSizePt));
    }
    if (edit.color && dom.textColorInput) {
      dom.textColorInput.value = edit.color;
    }
  }
}

/**
 * 選択中の編集ツールを切り替える
 * @param {'direct-text' | 'text' | 'shape' | 'image' | 'whiteout'} toolName - ツール名
 */
function setActiveTool(toolName) {
  editorState.currentTool = toolName;
  hideTextInputPopover();

  dom.toolDirectTextBtn?.classList.toggle('active', toolName === 'direct-text');
  dom.toolTextBtn?.classList.toggle('active', toolName === 'text');
  dom.toolShapeBtn?.classList.toggle('active', toolName === 'shape');
  dom.toolImageBtn?.classList.toggle('active', toolName === 'image');
  dom.toolWhiteoutBtn?.classList.toggle('active', toolName === 'whiteout');

  // ツール別オプションバーの表示切替
  const showTextOpts = toolName === 'direct-text' || toolName === 'text';
  const showShapeOpts = toolName === 'shape';
  const showImageOpts = toolName === 'image';

  dom.textToolOptions?.classList.toggle('hidden', !showTextOpts);
  dom.shapeToolOptions?.classList.toggle('hidden', !showShapeOpts);
  dom.imageToolOptions?.classList.toggle('hidden', !showImageOpts);

  dom.overlayCanvas?.classList.remove(
    'mode-direct-text',
    'mode-text',
    'mode-shape',
    'mode-image',
    'mode-whiteout'
  );

  if (toolName === 'direct-text') {
    dom.overlayCanvas?.classList.add('mode-direct-text');
    const detectedCount = editorState.detectedTextItems.length;
    dom.guideText.innerHTML = `
      <i data-lucide="info"></i>
      <span>【テキスト編集モード】検出された既存テキスト枠（${detectedCount}箇所）をクリックして文字の書き換え・削除が可能です。編集後の文字はドラッグで移動できます。</span>
    `;
    preloadJapaneseFont().catch(() => {});
  } else if (toolName === 'text') {
    dom.overlayCanvas?.classList.add('mode-text');
    dom.guideText.innerHTML = `
      <i data-lucide="info"></i>
      <span>【新規文字追加モード】任意の位置をクリックして文字を追加できます。追加済みの文字はドラッグで位置微調整、クリックで再編集・削除が可能です。</span>
    `;
    preloadJapaneseFont().catch(() => {});
  } else if (toolName === 'shape') {
    dom.overlayCanvas?.classList.add('mode-shape');
    dom.guideText.innerHTML = `
      <i data-lucide="info"></i>
      <span>【図形追加モード (□・〇等)】ドラッグして任意の大きさで描画、またはクリックで標準サイズを配置します（Shift押下で正方形・正円）。配置後は移動・四隅リサイズが可能です。</span>
    `;
  } else if (toolName === 'image') {
    dom.overlayCanvas?.classList.add('mode-image');
    dom.guideText.innerHTML = `
      <i data-lucide="info"></i>
      <span>【画像貼付モード (.png / .jpeg)】「画像を選択」ボタン、ページ上クリック、画像ファイルのドラッグ＆ドロップ、または Ctrl+V で画像を貼り付けできます。</span>
    `;
  } else {
    dom.overlayCanvas?.classList.add('mode-whiteout');
    dom.guideText.innerHTML = `
      <i data-lucide="info"></i>
      <span>【白塗りモード】ページ上をドラッグすると、選択した矩形領域を白色で塗りつぶします（墨消し・不要箇所の消去）。</span>
    `;
  }

  if (window.lucide) {
    window.lucide.createIcons({ attrs: { class: 'lucide' } });
  }
  updateToolbarState();
  redrawOverlayCanvas();
}

/**
 * 履歴操作ボタン（選択削除・戻す・リセット）および編集件数ラベルを更新する
 */
function updateToolbarState() {
  const edits = editorState.currentPageItem?.edits || [];
  const count = edits.length;

  // 選択中のIDが現在のedits内に存在するか確認
  const selectedEdit = getSelectedEditItem();
  if (!selectedEdit) {
    editorState.selectedEditId = null;
  }

  if (dom.deleteSelectedBtn) {
    dom.deleteSelectedBtn.disabled = !selectedEdit;
  }
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
    const toHex = (n) =>
      Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
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

  if (
    edit.type === 'replace-text' &&
    (!edit.text || String(edit.text).length === 0)
  ) {
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
  const textWidth = Math.max(
    16,
    ctx.measureText(String(edit.text || '')).width
  );
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
 * 任意の編集要素（image / shape / whiteout / text / replace-text）のキャンバス上バウンディングボックスを算出する
 * @param {object} edit - 編集要素
 * @param {HTMLCanvasElement} canvas - 対象キャンバス
 * @returns {{ x: number, y: number, w: number, h: number } | null}
 */
function getEditBoundingBoxOnCanvas(edit, canvas) {
  if (!edit || !canvas) {
    return null;
  }
  if (
    edit.type === 'image' ||
    edit.type === 'shape' ||
    edit.type === 'whiteout'
  ) {
    return {
      x: edit.xRatio * canvas.width,
      y: edit.yRatio * canvas.height,
      w: Math.max(8, (edit.widthRatio || 0.05) * canvas.width),
      h: Math.max(8, (edit.heightRatio || 0.05) * canvas.height)
    };
  }
  return getEditTextBoundingBoxOnCanvas(edit, canvas);
}

/**
 * リサイズ可能なボックス要素（image / shape / whiteout）の8方向リサイズハンドル座標リストを返す
 * @param {{ x: number, y: number, w: number, h: number }} box - バウンディングボックス
 * @returns {Array<{ name: string, x: number, y: number, cursor: string }>}
 */
function getResizeHandlesForBox(box) {
  const { x, y, w, h } = box;
  return [
    { name: 'nw', x, y, cursor: 'nwse-resize' },
    { name: 'n', x: x + w / 2, y, cursor: 'ns-resize' },
    { name: 'ne', x: x + w, y, cursor: 'nesw-resize' },
    { name: 'e', x: x + w, y: y + h / 2, cursor: 'ew-resize' },
    { name: 'se', x: x + w, y: y + h, cursor: 'nwse-resize' },
    { name: 's', x: x + w / 2, y: y + h, cursor: 'ns-resize' },
    { name: 'sw', x, y: y + h, cursor: 'nesw-resize' },
    { name: 'w', x, y: y + h / 2, cursor: 'ew-resize' }
  ];
}

/**
 * 現在選択中のボックス要素（image / shape / whiteout）のリサイズハンドルにヒットしたか判定する
 * @param {number} x - キャンバスX座標
 * @param {number} y - キャンバスY座標
 * @returns {{ edit: object, handleName: string, cursor: string } | null}
 */
function findHitResizeHandle(x, y) {
  const selected = getSelectedEditItem();
  const canvas = dom.overlayCanvas;
  if (!selected || !canvas) {
    return null;
  }
  if (
    selected.type !== 'image' &&
    selected.type !== 'shape' &&
    selected.type !== 'whiteout'
  ) {
    return null;
  }

  const box = getEditBoundingBoxOnCanvas(selected, canvas);
  if (!box) {
    return null;
  }

  const handles = getResizeHandlesForBox(box);
  const hitRadius = 8;
  for (const h of handles) {
    if (Math.abs(x - h.x) <= hitRadius && Math.abs(y - h.y) <= hitRadius) {
      return { edit: selected, handleName: h.name, cursor: h.cursor };
    }
  }
  return null;
}

/**
 * キャンバス座標 (x, y) にある既存の編集済み要素（後ろ＝最前面から優先）を検索する
 * @param {number} x - キャンバスX座標
 * @param {number} y - キャンバスY座標
 * @returns {object | null} ヒットした編集要素
 */
function findHitEditItem(x, y) {
  const edits = editorState.currentPageItem?.edits || [];
  const canvas = dom.overlayCanvas;
  if (!canvas || edits.length === 0) {
    return null;
  }

  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    // 白塗りは白塗りモード時または既に選択中のときのみヒット対象にする
    if (
      edit.type === 'whiteout' &&
      editorState.currentTool !== 'whiteout' &&
      editorState.selectedEditId !== edit.id
    ) {
      continue;
    }

    const box = getEditBoundingBoxOnCanvas(edit, canvas);
    if (!box) {
      continue;
    }

    // 塗りつぶしなしの図形 (shape) で、現在が direct-text モードの場合は、内部の既存テキストをクリックしやすくするため枠線付近のみヒット判定にする
    if (
      edit.type === 'shape' &&
      !edit.fillEnabled &&
      editorState.currentTool === 'direct-text' &&
      editorState.selectedEditId !== edit.id
    ) {
      const borderPad = 8;
      const insideOuter =
        x >= box.x - borderPad &&
        x <= box.x + box.w + borderPad &&
        y >= box.y - borderPad &&
        y <= box.y + box.h + borderPad;
      const insideInner =
        x >= box.x + borderPad &&
        x <= box.x + box.w - borderPad &&
        y >= box.y + borderPad &&
        y <= box.y + box.h - borderPad;
      if (insideOuter && !insideInner) {
        return edit;
      }
      continue;
    }

    if (
      x >= box.x &&
      x <= box.x + box.w &&
      y >= box.y &&
      y <= box.y + box.h
    ) {
      return edit;
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
 * 現在ツールバーで設定されている図形スタイル設定オブジェクトを取得する
 */
function getCurrentToolbarShapeConfig() {
  return {
    shapeType: dom.shapeTypeSelect?.value || 'rect',
    strokeWidthPt: Math.max(
      0.5,
      Math.min(24, Number(dom.shapeStrokeWidthInput?.value) || 2)
    ),
    strokeColor: dom.shapeStrokeColorInput?.value || '#000000',
    fillEnabled: Boolean(dom.shapeFillEnabledInput?.checked),
    fillColor: dom.shapeFillColorInput?.value || '#ffffff'
  };
}

/**
 * オーバーレイキャンバスを再描画する
 * （確定済み編集 + 既存テキストハイライト枠 + 編集要素選択枠・リサイズハンドル + 図形/白塗りラバーバンド + 挿入マーカー）
 */
function redrawOverlayCanvas() {
  const canvas = dom.overlayCanvas;
  if (!canvas) {
    return;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const edits = editorState.currentPageItem?.edits || [];
  const scaleFactor =
    editorState.currentPdfPointWidth > 0
      ? canvas.width / editorState.currentPdfPointWidth
      : 1;

  // 画像の非同期デコード完了時に再描画をトリガーするチェック
  for (const edit of edits) {
    if (edit.type === 'image' && edit.dataUrl) {
      getCachedImageElement(edit.dataUrl, () => {
        redrawOverlayCanvas();
      });
    }
  }

  // 1. 確定済みの白塗り・図形・画像・既存テキスト置換/削除・新規テキストを描画
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

  // 3. 編集済み要素の視覚ガイド枠および選択中要素のリサイズハンドルを描画
  ctx.save();
  for (const edit of edits) {
    const box = getEditBoundingBoxOnCanvas(edit, canvas);
    if (!box) {
      continue;
    }

    const isSelected = editorState.selectedEditId === edit.id;
    const isHovered =
      editorState.hoveredEditId === edit.id ||
      editorState.draggingEditItem?.id === edit.id ||
      editorState.resizingEditItem?.id === edit.id;

    if (edit.type === 'whiteout') {
      ctx.strokeStyle = isSelected
        ? '#2563eb'
        : isHovered
          ? '#64748b'
          : 'rgba(100, 116, 139, 0.35)';
      ctx.lineWidth = isSelected ? 1.8 : 1;
      ctx.setLineDash(isSelected ? [] : [4, 3]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
    } else if (edit.type === 'shape' || edit.type === 'image') {
      if (isSelected || isHovered) {
        ctx.strokeStyle = isSelected ? '#2563eb' : 'rgba(37, 99, 235, 0.65)';
        ctx.lineWidth = isSelected ? 1.8 : 1.2;
        ctx.setLineDash(isSelected ? [5, 3] : [3, 3]);
        ctx.strokeRect(box.x, box.y, box.w, box.h);
      }
    } else if (edit.type === 'text' || edit.type === 'replace-text') {
      ctx.strokeStyle = isSelected
        ? '#2563eb'
        : isHovered
          ? '#d97706'
          : 'rgba(217, 119, 6, 0.65)';
      ctx.lineWidth = isSelected || isHovered ? 2 : 1.2;
      ctx.setLineDash([4, 2]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
    }

    // 選択中の図形・画像・白塗り要素には8方向のリサイズハンドルを描画
    if (
      isSelected &&
      (edit.type === 'shape' ||
        edit.type === 'image' ||
        edit.type === 'whiteout')
    ) {
      const handles = getResizeHandlesForBox(box);
      ctx.setLineDash([]);
      for (const h of handles) {
        const isHandleHovered = editorState.hoveredResizeHandle === h.name;
        const size = isHandleHovered ? 9 : 7;
        ctx.fillStyle = isHandleHovered ? '#2563eb' : '#ffffff';
        ctx.strokeStyle = '#1d4ed8';
        ctx.lineWidth = 1.6;
        ctx.fillRect(h.x - size / 2, h.y - size / 2, size, size);
        ctx.strokeRect(h.x - size / 2, h.y - size / 2, size, size);
      }
    }
  }
  ctx.restore();

  // 4. 図形ドラッグ描画中のリアルタイムプレビュー
  if (editorState.isDraggingShape && editorState.currentTool === 'shape') {
    const { rectX, rectY, rectW, rectH } = computeCurrentDragShapeRect();
    if (rectW >= 2 && rectH >= 2) {
      const shapeConfig = getCurrentToolbarShapeConfig();
      drawShapeOnCanvasContext(
        ctx,
        shapeConfig,
        rectX,
        rectY,
        rectW,
        rectH,
        scaleFactor
      );
      ctx.save();
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rectX, rectY, rectW, rectH);
      ctx.restore();
    }
  }

  // 5. 白塗りドラッグ中のラバーバンド矩形プレビューを描画
  if (
    editorState.isDraggingWhiteout &&
    editorState.currentTool === 'whiteout'
  ) {
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

  // 6. ポップオーバー表示中のターゲットマーカーを描画
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
 * 図形ドラッグ描画中の矩形 (rectX, rectY, rectW, rectH) を算出する（Shiftキーによる1:1正円/正方形拘束対応）
 */
function computeCurrentDragShapeRect() {
  const sx = editorState.dragStartX;
  const sy = editorState.dragStartY;
  const cx = editorState.dragCurrentX;
  const cy = editorState.dragCurrentY;

  let dx = cx - sx;
  let dy = cy - sy;

  if (editorState.isShiftPressedDuringDrag) {
    const maxSide = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx >= 0 ? 1 : -1) * maxSide;
    dy = (dy >= 0 ? 1 : -1) * maxSide;
  }

  const rectX = dx >= 0 ? sx : sx + dx;
  const rectY = dy >= 0 ? sy : sy + dy;
  const rectW = Math.abs(dx);
  const rectH = Math.abs(dy);

  return { rectX, rectY, rectW, rectH };
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

  if (dom.popoverDeleteTextBtn) {
    const showDelete =
      targetConfig.mode === 'replace-detected-text' ||
      targetConfig.mode === 'edit-existing-edit';
    dom.popoverDeleteTextBtn.classList.toggle('hidden', !showDelete);
  }

  if (targetConfig.fontFamily && dom.textFontSelect) {
    dom.textFontSelect.value = targetConfig.fontFamily;
  }
  if (targetConfig.fontSizePt && dom.textSizeInput) {
    dom.textSizeInput.value = String(Math.round(targetConfig.fontSizePt));
  }
  if (targetConfig.color && dom.textColorInput) {
    dom.textColorInput.value = targetConfig.color;
  }

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

  preloadJapaneseFont(fontFamily).catch(() => {});

  if (target.mode === 'replace-detected-text') {
    const det = target.detectedItem;
    const bgColor = sampleSurroundingBackgroundColor(
      det.maskXRatio,
      det.maskYRatio,
      det.maskWidthRatio,
      det.maskHeightRatio
    );

    const newEdit = {
      id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'replace-text',
      targetKey: det.key,
      originalText: det.originalText,
      text: inputText,
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
    };
    pageItem.edits.push(newEdit);
    editorState.selectedEditId = newEdit.id;
  } else if (target.mode === 'edit-existing-edit') {
    const existingEdit = pageItem.edits.find((e) => e.id === target.editId);
    if (existingEdit) {
      if (existingEdit.type === 'text' && !inputText.trim()) {
        const idx = pageItem.edits.indexOf(existingEdit);
        if (idx !== -1) {
          pageItem.edits.splice(idx, 1);
        }
        editorState.selectedEditId = null;
      } else {
        existingEdit.text = inputText;
        existingEdit.fontFamily = fontFamily;
        existingEdit.fontSizePt = fontSizePt;
        existingEdit.color = color;
        editorState.selectedEditId = existingEdit.id;
      }
    }
  } else if (target.mode === 'new-text') {
    if (inputText.trim().length > 0) {
      const newEdit = {
        id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        type: 'text',
        xRatio: target.xRatio,
        yRatio: target.yRatio,
        text: inputText.trim(),
        fontFamily,
        fontSizePt,
        color
      };
      pageItem.edits.push(newEdit);
      editorState.selectedEditId = newEdit.id;
    }
  }

  hideTextInputPopover();
  updateToolbarState();
  redrawOverlayCanvas();
}

/**
 * ポップオーバーの「文字削除」ボタンが押されたときの処理
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

    const newEdit = {
      id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'replace-text',
      targetKey: det.key,
      originalText: det.originalText,
      text: '',
      xRatio: det.xRatio,
      yRatio: det.yRatio,
      maskXRatio: det.maskXRatio,
      maskYRatio: det.maskYRatio,
      maskWidthRatio: det.maskWidthRatio,
      maskHeightRatio: det.maskHeightRatio,
      bgColor,
      fontSizePt: det.fontSizePt || 12,
      color: '#000000'
    };
    pageItem.edits.push(newEdit);
    editorState.selectedEditId = newEdit.id;
  } else if (target.mode === 'edit-existing-edit') {
    const existingEdit = pageItem.edits.find((e) => e.id === target.editId);
    if (existingEdit) {
      if (existingEdit.type === 'replace-text') {
        existingEdit.text = '';
      } else {
        const idx = pageItem.edits.indexOf(existingEdit);
        if (idx !== -1) {
          pageItem.edits.splice(idx, 1);
        }
        editorState.selectedEditId = null;
      }
    }
  }

  hideTextInputPopover();
  updateToolbarState();
  redrawOverlayCanvas();
}

/**
 * 現在選択中の編集要素（図形・画像・テキスト・白塗り）をページから削除する
 */
function deleteSelectedEditItem() {
  const pageItem = editorState.currentPageItem;
  if (!pageItem || !Array.isArray(pageItem.edits) || !editorState.selectedEditId) {
    return;
  }
  const idx = pageItem.edits.findIndex(
    (e) => e.id === editorState.selectedEditId
  );
  if (idx !== -1) {
    pageItem.edits.splice(idx, 1);
    editorState.selectedEditId = null;
    hideTextInputPopover();
    updateToolbarState();
    redrawOverlayCanvas();
  }
}

/**
 * 画像ファイル (.png / .jpeg / .webp 等) を読み込んで現在編集中のページへ配置する
 * @param {File | Blob} file - 画像ファイル
 * @param {{ xRatio: number, yRatio: number } | null} [targetCenterRatio=null] - 配置中心の正規化座標（省略時は中央 0.5, 0.5）
 */
async function addImageFileToCurrentPage(file, targetCenterRatio = null) {
  const pageItem = editorState.currentPageItem;
  const canvas = dom.overlayCanvas;
  if (!pageItem || !canvas || !file) {
    return;
  }

  try {
    const imgInfo = await loadImageFileForEditor(file);

    // ページ上の初期サイズを決定（縦横比を保ったまま最大幅32%・最大高さ32%以内に収める）
    const pageAspect =
      canvas.height > 0 ? canvas.width / canvas.height : 595.28 / 841.89;
    const imgAspect = imgInfo.aspectRatio || 1;

    let widthRatio = 0.28;
    let heightRatio = (widthRatio * pageAspect) / imgAspect;

    if (heightRatio > 0.28) {
      heightRatio = 0.28;
      widthRatio = (heightRatio * imgAspect) / pageAspect;
    }

    widthRatio = Math.max(0.05, Math.min(0.85, widthRatio));
    heightRatio = Math.max(0.05, Math.min(0.85, heightRatio));

    const centerX = targetCenterRatio ? targetCenterRatio.xRatio : 0.5;
    const centerY = targetCenterRatio ? targetCenterRatio.yRatio : 0.5;

    const xRatio = Math.max(
      0,
      Math.min(1 - widthRatio, centerX - widthRatio / 2)
    );
    const yRatio = Math.max(
      0,
      Math.min(1 - heightRatio, centerY - heightRatio / 2)
    );

    if (!Array.isArray(pageItem.edits)) {
      pageItem.edits = [];
    }

    const newImageEdit = {
      id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'image',
      xRatio,
      yRatio,
      widthRatio,
      heightRatio,
      aspectRatio: imgInfo.aspectRatio,
      mimeType: imgInfo.mimeType,
      dataUrl: imgInfo.dataUrl,
      imageName: imgInfo.imageName
    };

    pageItem.edits.push(newImageEdit);
    editorState.selectedEditId = newImageEdit.id;

    if (editorState.currentTool !== 'image') {
      setActiveTool('image');
    } else {
      updateToolbarState();
      redrawOverlayCanvas();
    }
  } catch (error) {
    console.error('画像追加エラー:', error);
  }
}

/**
 * ポインターイベントからキャンバス内部の正確なピクセル座標 (x, y) を算出する
 * @param {PointerEvent | MouseEvent | DragEvent} event - イベント
 * @returns {{ x: number, y: number }}
 */
function getCanvasCoordinates(event) {
  const canvas = dom.overlayCanvas;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / (rect.width || 1);
  const scaleY = canvas.height / (rect.height || 1);
  const x = Math.max(
    0,
    Math.min(canvas.width, (event.clientX - rect.left) * scaleX)
  );
  const y = Math.max(
    0,
    Math.min(canvas.height, (event.clientY - rect.top) * scaleY)
  );
  return { x, y };
}

/**
 * pdf.js の page.getTextContent() を使用してページ内の既存テキスト要素とバウンディングボックスを抽出する
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

      const tx = Util.transform(viewport.transform, item.transform);
      const fontHeightPx = Math.max(6, Math.hypot(tx[2], tx[3]));
      const fontSizePt = Math.max(
        6,
        Math.round((fontHeightPx / (viewport.scale || 1)) * 10) / 10
      );

      const rawItemWidthPx = (item.width || 0) * (viewport.scale || 1);
      const estimatedWidthPx = Math.max(
        fontHeightPx * 0.6,
        rawItemWidthPx > 2 ? rawItemWidthPx : str.length * fontHeightPx * 0.65
      );

      const baseX = tx[4];
      const baseY = tx[5];

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

  if (pageItem.type === 'blank') {
    const { width: viewW, height: viewH } =
      getEffectivePageDimensions(pageItem);
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
 * リサイズハンドルドラッグ中の新しい正規化座標 (xRatio, yRatio, widthRatio, heightRatio) を適用する
 */
function applyResizeDrag(x, y, shiftKey) {
  const edit = editorState.resizingEditItem;
  const handle = editorState.resizeHandleName;
  const init = editorState.resizeInitialBox;
  const canvas = dom.overlayCanvas;
  if (!edit || !handle || !init || !canvas) {
    return;
  }

  const dxRatio = (x - editorState.resizeStartCanvasX) / canvas.width;
  const dyRatio = (y - editorState.resizeStartCanvasY) / canvas.height;
  const minW = 10 / canvas.width;
  const minH = 10 / canvas.height;

  let newX = init.xRatio;
  let newY = init.yRatio;
  let newW = init.widthRatio;
  let newH = init.heightRatio;

  if (handle.includes('e')) {
    newW = Math.max(minW, Math.min(1 - newX, init.widthRatio + dxRatio));
  }
  if (handle.includes('s')) {
    newH = Math.max(minH, Math.min(1 - newY, init.heightRatio + dyRatio));
  }
  if (handle.includes('w')) {
    const maxDeltaX = init.widthRatio - minW;
    const clampedDx = Math.max(-init.xRatio, Math.min(maxDeltaX, dxRatio));
    newX = init.xRatio + clampedDx;
    newW = init.widthRatio - clampedDx;
  }
  if (handle.includes('n')) {
    const maxDeltaY = init.heightRatio - minH;
    const clampedDy = Math.max(-init.yRatio, Math.min(maxDeltaY, dyRatio));
    newY = init.yRatio + clampedDy;
    newH = init.heightRatio - clampedDy;
  }

  // 四隅のハンドル操作時：画像の縦横比維持またはShiftキーによる比率ロック
  const isCorner =
    handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw';
  const lockImageAspect =
    edit.type === 'image' && Boolean(dom.imageLockAspectInput?.checked);

  if (isCorner && (lockImageAspect || shiftKey) && init.aspectPx > 0) {
    const targetAspectPx = shiftKey && edit.type === 'shape' ? 1 : init.aspectPx;
    const currentWpx = newW * canvas.width;
    const adjustedHpx = currentWpx / targetAspectPx;
    const adjustedHRatio = Math.max(minH, adjustedHpx / canvas.height);

    if (handle.includes('n')) {
      const bottomY = init.yRatio + init.heightRatio;
      if (bottomY - adjustedHRatio >= 0) {
        newY = bottomY - adjustedHRatio;
        newH = adjustedHRatio;
      }
    } else if (newY + adjustedHRatio <= 1) {
      newH = adjustedHRatio;
    }
  }

  edit.xRatio = newX;
  edit.yRatio = newY;
  edit.widthRatio = newW;
  edit.heightRatio = newH;
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
  dom.toolShapeBtn?.addEventListener('click', () => setActiveTool('shape'));
  dom.toolImageBtn?.addEventListener('click', () => setActiveTool('image'));
  dom.toolWhiteoutBtn?.addEventListener('click', () =>
    setActiveTool('whiteout')
  );

  // 図形設定コントロールのイベント（選択中の図形があればリアルタイム反映）
  const applyShapeToolbarChangesToSelected = () => {
    const selected = getSelectedEditItem();
    if (selected && selected.type === 'shape') {
      const cfg = getCurrentToolbarShapeConfig();
      selected.shapeType = cfg.shapeType;
      selected.strokeWidthPt = cfg.strokeWidthPt;
      selected.strokeColor = cfg.strokeColor;
      selected.fillEnabled = cfg.fillEnabled;
      selected.fillColor = cfg.fillColor;
      redrawOverlayCanvas();
    }
  };

  for (const btn of dom.shapeQuickBtns) {
    btn.addEventListener('click', () => {
      const shapeType = btn.dataset.shape || 'rect';
      syncShapeQuickButtons(shapeType);
      if (editorState.currentTool !== 'shape') {
        setActiveTool('shape');
      }
      applyShapeToolbarChangesToSelected();
    });
  }

  dom.shapeTypeSelect?.addEventListener('change', (event) => {
    syncShapeQuickButtons(event.target.value || 'rect');
    applyShapeToolbarChangesToSelected();
  });
  dom.shapeStrokeWidthInput?.addEventListener(
    'input',
    applyShapeToolbarChangesToSelected
  );
  dom.shapeStrokeColorInput?.addEventListener(
    'input',
    applyShapeToolbarChangesToSelected
  );
  dom.shapeFillEnabledInput?.addEventListener(
    'change',
    applyShapeToolbarChangesToSelected
  );
  dom.shapeFillColorInput?.addEventListener('input', () => {
    // 塗り色が変更されたら自動的に「塗り」チェックをONにする
    if (dom.shapeFillEnabledInput && !dom.shapeFillEnabledInput.checked) {
      dom.shapeFillEnabledInput.checked = true;
    }
    applyShapeToolbarChangesToSelected();
  });

  // 画像選択ボタン & ファイルInput
  dom.imageUploadBtn?.addEventListener('click', () => {
    editorState.pendingImagePointRatio = null;
    dom.imageFileInput?.click();
  });

  dom.imageFileInput?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) {
      await addImageFileToCurrentPage(file, editorState.pendingImagePointRatio);
    }
    editorState.pendingImagePointRatio = null;
    event.target.value = '';
  });

  // モーダル内への画像ドラッグ＆ドロップ対応
  dom.viewport?.addEventListener('dragover', (event) => {
    if (!editorState.isOpen) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dom.viewport.classList.add('drag-over-image');
  });

  dom.viewport?.addEventListener('dragleave', (event) => {
    if (event.target === dom.viewport) {
      dom.viewport.classList.remove('drag-over-image');
    }
  });

  dom.viewport?.addEventListener('drop', async (event) => {
    if (!editorState.isOpen) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dom.viewport.classList.remove('drag-over-image');

    const files = Array.from(event.dataTransfer?.files || []);
    const imageFile = files.find(
      (f) =>
        f.type.startsWith('image/') ||
        /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)
    );
    if (imageFile) {
      const { x, y } = getCanvasCoordinates(event);
      const canvas = dom.overlayCanvas;
      const targetRatio =
        canvas && canvas.width > 0 && canvas.height > 0
          ? { xRatio: x / canvas.width, yRatio: y / canvas.height }
          : null;
      await addImageFileToCurrentPage(imageFile, targetRatio);
    }
  });

  // Ctrl+V（クリップボードからの画像貼り付け）対応
  window.addEventListener('paste', async (event) => {
    if (!editorState.isOpen || editorState.popoverTarget) {
      return;
    }
    const items = Array.from(event.clipboardData?.items || []);
    const imgItem = items.find((item) => item.type.startsWith('image/'));
    if (imgItem) {
      const blob = imgItem.getAsFile();
      if (blob) {
        event.preventDefault();
        await addImageFileToCurrentPage(blob, null);
      }
    }
  });

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

  // 選択削除ボタン
  dom.deleteSelectedBtn?.addEventListener('click', () => {
    deleteSelectedEditItem();
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
    editorState.selectedEditId = null;
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

  // キーボード操作（Escapeで閉じる、Delete/Backspaceで選択中要素を削除）
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
      return;
    }

    const activeTag = document.activeElement?.tagName?.toLowerCase();
    const isInputFocused =
      activeTag === 'input' ||
      activeTag === 'textarea' ||
      activeTag === 'select';

    if (
      !isInputFocused &&
      !editorState.popoverTarget &&
      (event.key === 'Delete' || event.key === 'Backspace') &&
      editorState.selectedEditId
    ) {
      event.preventDefault();
      deleteSelectedEditItem();
    }
  });

  // オーバーレイキャンバス上のポインターダウン
  dom.overlayCanvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    const { x, y } = getCanvasCoordinates(event);
    const canvas = dom.overlayCanvas;

    // 1. 選択中の図形・画像・白塗り要素のリサイズハンドルを掴んだか判定
    const hitHandle = findHitResizeHandle(x, y);
    if (hitHandle) {
      hideTextInputPopover();
      const target = hitHandle.edit;
      const box = getEditBoundingBoxOnCanvas(target, canvas);
      editorState.resizingEditItem = target;
      editorState.resizeHandleName = hitHandle.handleName;
      editorState.resizeStartCanvasX = x;
      editorState.resizeStartCanvasY = y;
      editorState.resizeInitialBox = {
        xRatio: target.xRatio,
        yRatio: target.yRatio,
        widthRatio: target.widthRatio || 0.1,
        heightRatio: target.heightRatio || 0.1,
        aspectPx: box && box.h > 0 ? box.w / box.h : 1
      };
      canvas.setPointerCapture(event.pointerId);
      redrawOverlayCanvas();
      return;
    }

    // 2. 既に追加・編集済みの要素（画像・図形・テキスト・白塗り）の上を押したか判定
    const hitEdit = findHitEditItem(x, y);
    if (hitEdit) {
      hideTextInputPopover();
      editorState.selectedEditId = hitEdit.id;
      syncToolbarOptionsFromSelectedEdit(hitEdit);
      updateToolbarState();

      editorState.draggingEditItem = hitEdit;
      editorState.dragEditStartCanvasX = x;
      editorState.dragEditStartCanvasY = y;
      editorState.dragEditInitialXRatio = hitEdit.xRatio;
      editorState.dragEditInitialYRatio = hitEdit.yRatio;
      editorState.hasMovedDuringEditDrag = false;
      canvas.setPointerCapture(event.pointerId);
      redrawOverlayCanvas();
      return;
    }

    // 余白をクリックした場合は選択解除
    editorState.selectedEditId = null;
    updateToolbarState();

    // 3. 白塗りモード時：白塗りドラッグ開始
    if (editorState.currentTool === 'whiteout') {
      hideTextInputPopover();
      editorState.isDraggingWhiteout = true;
      editorState.dragStartX = x;
      editorState.dragStartY = y;
      editorState.dragCurrentX = x;
      editorState.dragCurrentY = y;
      canvas.setPointerCapture(event.pointerId);
      redrawOverlayCanvas();
      return;
    }

    // 4. 図形追加モード時：図形ドラッグ描画（またはクリック配置）開始
    if (editorState.currentTool === 'shape') {
      hideTextInputPopover();
      editorState.isDraggingShape = true;
      editorState.dragStartX = x;
      editorState.dragStartY = y;
      editorState.dragCurrentX = x;
      editorState.dragCurrentY = y;
      editorState.isShiftPressedDuringDrag = Boolean(event.shiftKey);
      canvas.setPointerCapture(event.pointerId);
      redrawOverlayCanvas();
      return;
    }

    // 5. 画像貼付モード時：クリックした位置を中心として画像ファイル選択ダイアログを開く
    if (editorState.currentTool === 'image') {
      hideTextInputPopover();
      editorState.pendingImagePointRatio = {
        xRatio: x / canvas.width,
        yRatio: y / canvas.height
      };
      dom.imageFileInput?.click();
      return;
    }

    // 6. ダイレクトテキスト編集モード時：検出された既存テキスト枠をクリックしたか判定
    if (editorState.currentTool === 'direct-text') {
      const hitDetected = findHitDetectedTextItem(x, y);
      if (hitDetected) {
        openTextPopover({
          mode: 'replace-detected-text',
          detectedItem: hitDetected,
          initialText: hitDetected.originalText,
          fontSizePt: hitDetected.fontSizePt,
          color: dom.textColorInput?.value || '#000000',
          canvasX: hitDetected.maskXRatio * canvas.width,
          canvasY: hitDetected.maskYRatio * canvas.height
        });
        return;
      }
    }

    // 7. 新規テキスト追加モード（またはダイレクト編集モードで余白をクリックした場合）：新規テキスト追加ポップオーバーを表示
    openTextPopover({
      mode: 'new-text',
      initialText: '',
      fontSizePt: Number(dom.textSizeInput?.value) || 16,
      color: dom.textColorInput?.value || '#000000',
      xRatio: Math.max(0, Math.min(0.98, x / canvas.width)),
      yRatio: Math.max(0, Math.min(0.98, y / canvas.height)),
      canvasX: x,
      canvasY: y
    });
  });

  // ポインタームーブ（リサイズ・ドラッグ移動・図形/白塗りプレビュー・ホバーハイライト）
  dom.overlayCanvas.addEventListener('pointermove', (event) => {
    const { x, y } = getCanvasCoordinates(event);
    const canvas = dom.overlayCanvas;

    // 1. リサイズハンドルドラッグ中
    if (editorState.resizingEditItem) {
      applyResizeDrag(x, y, Boolean(event.shiftKey));
      redrawOverlayCanvas();
      return;
    }

    // 2. 編集要素（画像・図形・テキスト・白塗り）のドラッグ移動中
    if (editorState.draggingEditItem) {
      const dx = x - editorState.dragEditStartCanvasX;
      const dy = y - editorState.dragEditStartCanvasY;
      if (Math.hypot(dx, dy) >= 3) {
        editorState.hasMovedDuringEditDrag = true;
      }
      if (editorState.hasMovedDuringEditDrag) {
        const item = editorState.draggingEditItem;
        const maxX =
          item.type === 'image' ||
          item.type === 'shape' ||
          item.type === 'whiteout'
            ? Math.max(0, 1 - (item.widthRatio || 0.05))
            : 0.98;
        const maxY =
          item.type === 'image' ||
          item.type === 'shape' ||
          item.type === 'whiteout'
            ? Math.max(0, 1 - (item.heightRatio || 0.05))
            : 0.98;

        item.xRatio = Math.max(
          0,
          Math.min(maxX, editorState.dragEditInitialXRatio + dx / canvas.width)
        );
        item.yRatio = Math.max(
          0,
          Math.min(maxY, editorState.dragEditInitialYRatio + dy / canvas.height)
        );
        redrawOverlayCanvas();
      }
      return;
    }

    // 3. 図形ドラッグ描画中
    if (editorState.isDraggingShape && editorState.currentTool === 'shape') {
      editorState.dragCurrentX = x;
      editorState.dragCurrentY = y;
      editorState.isShiftPressedDuringDrag = Boolean(event.shiftKey);
      redrawOverlayCanvas();
      return;
    }

    // 4. 白塗りドラッグ中
    if (
      editorState.isDraggingWhiteout &&
      editorState.currentTool === 'whiteout'
    ) {
      editorState.dragCurrentX = x;
      editorState.dragCurrentY = y;
      redrawOverlayCanvas();
      return;
    }

    // 5. ホバー状態およびカーソル形状の更新
    const hitHandle = findHitResizeHandle(x, y);
    const newHoveredHandle = hitHandle ? hitHandle.handleName : null;

    const hitEdit = hitHandle ? hitHandle.edit : findHitEditItem(x, y);
    const newHoveredEditId = hitEdit ? hitEdit.id : null;

    let newHoveredDetectedKey = null;
    if (!hitEdit && editorState.currentTool === 'direct-text') {
      const hitDet = findHitDetectedTextItem(x, y);
      if (hitDet) {
        newHoveredDetectedKey = hitDet.key;
      }
    }

    if (hitHandle) {
      canvas.style.cursor = hitHandle.cursor;
    } else if (hitEdit) {
      canvas.style.cursor = 'move';
    } else {
      canvas.style.cursor = '';
    }

    if (
      newHoveredHandle !== editorState.hoveredResizeHandle ||
      newHoveredEditId !== editorState.hoveredEditId ||
      newHoveredDetectedKey !== editorState.hoveredDetectedItemKey
    ) {
      editorState.hoveredResizeHandle = newHoveredHandle;
      editorState.hoveredEditId = newHoveredEditId;
      editorState.hoveredDetectedItemKey = newHoveredDetectedKey;
      redrawOverlayCanvas();
    }
  });

  // ポインターアップ（リサイズ完了・ドラッグ移動完了・図形/白塗り確定・クリック再編集）
  const finishPointerInteraction = (event) => {
    const canvas = dom.overlayCanvas;

    // 1. リサイズ完了
    if (editorState.resizingEditItem) {
      editorState.resizingEditItem = null;
      editorState.resizeHandleName = null;
      editorState.resizeInitialBox = null;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // 無視
      }
      redrawOverlayCanvas();
      return;
    }

    // 2. 編集要素のドラッグ移動またはクリック完了
    if (editorState.draggingEditItem) {
      const targetEdit = editorState.draggingEditItem;
      const moved = editorState.hasMovedDuringEditDrag;
      editorState.draggingEditItem = null;
      editorState.hasMovedDuringEditDrag = false;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // 無視
      }

      if (
        !moved &&
        (targetEdit.type === 'text' || targetEdit.type === 'replace-text')
      ) {
        // テキスト要素をドラッグせずにクリックした場合は再編集ポップオーバーを開く
        openTextPopover({
          mode: 'edit-existing-edit',
          editId: targetEdit.id,
          initialText: targetEdit.text || '',
          fontFamily: targetEdit.fontFamily || 'noto-sans',
          fontSizePt: targetEdit.fontSizePt || 16,
          color: targetEdit.color || '#000000',
          canvasX: targetEdit.xRatio * canvas.width,
          canvasY: targetEdit.yRatio * canvas.height
        });
      } else {
        redrawOverlayCanvas();
      }
      return;
    }

    // 3. 図形ドラッグ描画またはワンクリック配置の確定
    if (editorState.isDraggingShape && editorState.currentTool === 'shape') {
      editorState.isDraggingShape = false;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // 無視
      }

      const pageItem = editorState.currentPageItem;
      if (pageItem && canvas.width > 0 && canvas.height > 0) {
        const shapeConfig = getCurrentToolbarShapeConfig();
        let { rectX, rectY, rectW, rectH } = computeCurrentDragShapeRect();

        // ドラッグ量が小さい（単一クリック）の場合はクリック位置を中心に標準サイズの図形を配置
        if (rectW < 6 && rectH < 6) {
          const scaleFactor =
            editorState.currentPdfPointWidth > 0
              ? canvas.width / editorState.currentPdfPointWidth
              : 1;
          let defaultWpt = 44;
          let defaultHpt = 44;
          if (shapeConfig.shapeType === 'rect') {
            defaultWpt = 64;
            defaultHpt = 42;
          } else if (shapeConfig.shapeType === 'line') {
            defaultWpt = 100;
            defaultHpt = 16;
          }
          rectW = Math.max(16, defaultWpt * scaleFactor);
          rectH = Math.max(12, defaultHpt * scaleFactor);
          rectX = Math.max(
            0,
            Math.min(canvas.width - rectW, editorState.dragStartX - rectW / 2)
          );
          rectY = Math.max(
            0,
            Math.min(canvas.height - rectH, editorState.dragStartY - rectH / 2)
          );
        } else {
          rectW = Math.max(10, rectW);
          rectH = Math.max(10, rectH);
        }

        if (!Array.isArray(pageItem.edits)) {
          pageItem.edits = [];
        }

        const newShapeEdit = {
          id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: 'shape',
          shapeType: shapeConfig.shapeType,
          xRatio: Math.max(0, Math.min(0.98, rectX / canvas.width)),
          yRatio: Math.max(0, Math.min(0.98, rectY / canvas.height)),
          widthRatio: Math.max(0.015, Math.min(1, rectW / canvas.width)),
          heightRatio: Math.max(0.015, Math.min(1, rectH / canvas.height)),
          strokeColor: shapeConfig.strokeColor,
          fillEnabled: shapeConfig.fillEnabled,
          fillColor: shapeConfig.fillColor,
          strokeWidthPt: shapeConfig.strokeWidthPt
        };

        pageItem.edits.push(newShapeEdit);
        editorState.selectedEditId = newShapeEdit.id;
        updateToolbarState();
      }

      redrawOverlayCanvas();
      return;
    }

    // 4. 白塗りドラッグ完了
    if (
      editorState.isDraggingWhiteout &&
      editorState.currentTool === 'whiteout'
    ) {
      editorState.isDraggingWhiteout = false;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        // 無視
      }

      const rectX = Math.min(editorState.dragStartX, editorState.dragCurrentX);
      const rectY = Math.min(editorState.dragStartY, editorState.dragCurrentY);
      const rectW = Math.abs(editorState.dragCurrentX - editorState.dragStartX);
      const rectH = Math.abs(editorState.dragCurrentY - editorState.dragStartY);

      if (rectW >= 4 && rectH >= 4 && editorState.currentPageItem) {
        if (!Array.isArray(editorState.currentPageItem.edits)) {
          editorState.currentPageItem.edits = [];
        }
        const newWhiteout = {
          id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          type: 'whiteout',
          xRatio: rectX / canvas.width,
          yRatio: rectY / canvas.height,
          widthRatio: rectW / canvas.width,
          heightRatio: rectH / canvas.height,
          bgColor: '#ffffff'
        };
        editorState.currentPageItem.edits.push(newWhiteout);
        editorState.selectedEditId = newWhiteout.id;
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
  editorState.selectedEditId = null;

  if (!Array.isArray(pageItem.edits)) {
    pageItem.edits = [];
  }

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
  editorState.selectedEditId = null;

  if (dom.modal) {
    dom.modal.classList.add('hidden');
  }
  document.body.style.overflow = '';

  if (updatedPageId && typeof callback === 'function') {
    callback(updatedPageId);
  }
}
