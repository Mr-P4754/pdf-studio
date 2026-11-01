/**
 * @file app.js
 * @description アプリケーションのエントリーポイント / ステート一元管理 / 空白ページ挿入・左右回転・通しページ番号・ダイレクト編集連携
 */

import {
  PAPER_SIZES,
  normalizeRotation,
  inspectPdfDocument,
  getEffectivePageDimensions,
  preloadJapaneseFont,
  buildExportPdf,
  triggerPdfDownload,
  rotateEditsClockwise90,
  rotateEditsCounterClockwise90
} from './pdf-engine.js';
import {
  loadPdfJsDoc,
  renderThumbnailCanvas,
  createPageCardElement,
  updateCardStatusBadges,
  updateCardPageNumberIndicator,
  refreshGridOrderBadges,
  initSortableGrid
} from './preview.js';
import { initPageEditor, openPageEditorModal } from './editor.js';

/**
 * アプリケーション全体の内部ステート
 * 画面上のDOM順序と pageList 配列の順序を常に一貫させる
 */
const appState = {
  /**
   * 読み込み済みの元PDFファイルマップ
   * key: sourceFileId, value: { id, fileName, pdfBytes, pdfJsDoc, pageCount, pageRotations, pageSizes }
   * @type {Map<string, object>}
   */
  sourceFiles: new Map(),

  /**
   * 現在画面に並んでいるページの順序リスト（PDFページおよび空白ページ）
   * 各要素: {
   *   id: string,
   *   type: 'pdf' | 'blank',
   *   sourceFileId: string | null,
   *   fileName: string,
   *   pageIndex: number | null,
   *   width: number,
   *   height: number,
   *   paperLabel?: string,
   *   originalRotation: number,
   *   rotation: number,
   *   edits: Array<object>,
   *   pageNumberOverride: 'inherit' | 'hidden' | 'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-center' | 'top-right' | 'top-left'
   * }
   * @type {Array<object>}
   */
  pageList: [],

  /**
   * 通しページ番号（ヘッダー/フッター）の一括設定
   */
  pageNumberConfig: {
    enabled: false,
    format: 'hyphen', // 'simple' | 'hyphen' | 'p-dot' | 'page-en' | 'fraction'
    fontFamily: 'yu-mincho', // 'ms-mincho' | 'yu-mincho' | 'century' | 'times' | 'yu-gothic' | 'ms-gothic' | 'noto-sans' | 'noto-serif' | 'helvetica'
    fontSizePt: 10.5,
    startPage: 1, // 何枚目からページ番号を開始するか (1始まり)
    startNumber: 1, // 開始時のページ番号
    position: 'bottom-center'
  },

  fileSequence: 0,
  pageSequence: 0,
  isBusy: false,
  sortableInstance: null
};

/**
 * 主要DOM要素の参照
 */
const ui = {};

/**
 * DOM要素を取得してキャッシュする
 */
function cacheAppDomElements() {
  ui.fileInput = document.getElementById('file-input');
  ui.addFileBtn = document.getElementById('add-file-btn');
  ui.blankPageSizeSelect = document.getElementById('blank-page-size-select');
  ui.addBlankPageBtn = document.getElementById('add-blank-page-btn');
  ui.rotateAllCcwBtn = document.getElementById('rotate-all-ccw-btn');
  ui.rotateAllCwBtn = document.getElementById('rotate-all-cw-btn');
  ui.clearAllBtn = document.getElementById('clear-all-btn');
  ui.exportBtn = document.getElementById('export-btn');
  ui.totalPagesCount = document.getElementById('total-pages-count');
  ui.dropZone = document.getElementById('drop-zone');
  ui.dropZoneBtn = document.getElementById('drop-zone-btn');

  // 通しページ番号設定パネル
  ui.pageNumberPanel = document.getElementById('page-number-panel');
  ui.pageNumEnabled = document.getElementById('page-num-enabled');
  ui.pageNumFormat = document.getElementById('page-num-format');
  ui.pageNumFont = document.getElementById('page-num-font');
  ui.pageNumSize = document.getElementById('page-num-size');
  ui.pageNumStartPage = document.getElementById('page-num-start-page');
  ui.pageNumStart = document.getElementById('page-num-start');
  ui.pageNumPosition = document.getElementById('page-num-position');

  ui.workspaceInfoBar = document.getElementById('workspace-info-bar');
  ui.loadedFilesSummary = document.getElementById('loaded-files-summary');
  ui.workspaceSection = document.getElementById('workspace-section');
  ui.pageGrid = document.getElementById('page-grid');
  ui.globalDropOverlay = document.getElementById('global-drop-overlay');
  ui.loadingOverlay = document.getElementById('loading-overlay');
  ui.loadingMessage = document.getElementById('loading-message');
  ui.loadingSubmessage = document.getElementById('loading-submessage');
  ui.loadingProgressBar = document.getElementById('loading-progress-bar');
  ui.toastContainer = document.getElementById('toast-container');
}

/**
 * Lucide アイコンを描画・更新する
 */
function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons({ attrs: { class: 'lucide' } });
  }
}

/**
 * 全画面ローディングインジケーターを表示・更新する
 * @param {string} title - メインメッセージ
 * @param {string} [subtitle] - サブメッセージ
 * @param {number} [progressPercent] - 進捗率 (0〜100)
 */
function showLoading(
  title,
  subtitle = 'しばらくお待ちください...',
  progressPercent = 0
) {
  appState.isBusy = true;
  if (ui.loadingMessage) {
    ui.loadingMessage.textContent = title;
  }
  if (ui.loadingSubmessage) {
    ui.loadingSubmessage.textContent = subtitle;
  }
  if (ui.loadingProgressBar) {
    const clamped = Math.max(0, Math.min(100, Number(progressPercent) || 0));
    ui.loadingProgressBar.style.width = `${clamped}%`;
  }
  ui.loadingOverlay?.classList.remove('hidden');
}

/**
 * 全画面ローディングインジケーターを非表示にする
 */
function hideLoading() {
  appState.isBusy = false;
  ui.loadingOverlay?.classList.add('hidden');
  if (ui.loadingProgressBar) {
    ui.loadingProgressBar.style.width = '0%';
  }
}

/**
 * トースト通知を表示する
 * @param {string} message - 表示するメッセージ
 * @param {'info' | 'success' | 'error'} [type='info'] - 通知種別
 */
function showToast(message, type = 'info') {
  if (!ui.toastContainer) {
    return;
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  ui.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 200ms ease';
    setTimeout(() => {
      toast.remove();
    }, 220);
  }, 3600);
}

/**
 * 全カードの順番バッジ (#1, #2...) およびページ番号インジケーターを一括更新する
 */
function refreshAllPageOrderAndIndicators() {
  if (!ui.pageGrid) {
    return;
  }
  refreshGridOrderBadges(ui.pageGrid);

  const totalPages = appState.pageList.length;
  appState.pageList.forEach((pageItem, index) => {
    const cardElement = ui.pageGrid.querySelector(
      `.page-card[data-page-id="${CSS.escape(pageItem.id)}"]`
    );
    if (cardElement) {
      updateCardStatusBadges(cardElement, pageItem);
      updateCardPageNumberIndicator(
        cardElement,
        pageItem,
        appState.pageNumberConfig,
        index,
        totalPages,
        appState.pageList
      );
    }
  });
}

/**
 * 現在のページリスト状態に応じてヘッダーボタンやワークスペース表示を更新する
 */
function syncWorkspaceUiState() {
  const pageCount = appState.pageList.length;

  const activeFileIds = new Set(
    appState.pageList
      .filter((item) => item.type !== 'blank' && item.sourceFileId)
      .map((item) => item.sourceFileId)
  );
  const activeFileCount = activeFileIds.size;
  const blankCount = appState.pageList.filter(
    (item) => item.type === 'blank'
  ).length;

  if (ui.totalPagesCount) {
    ui.totalPagesCount.textContent = String(pageCount);
  }
  if (ui.loadedFilesSummary) {
    const blankInfo = blankCount > 0 ? ` (空白頁: ${blankCount}枚)` : '';
    ui.loadedFilesSummary.textContent = `読み込みファイル: ${activeFileCount}件 / 合計 ${pageCount}ページ${blankInfo}`;
  }

  const hasPages = pageCount > 0;
  if (ui.exportBtn) {
    ui.exportBtn.disabled = !hasPages;
  }
  if (ui.rotateAllCcwBtn) {
    ui.rotateAllCcwBtn.disabled = !hasPages;
  }
  if (ui.rotateAllCwBtn) {
    ui.rotateAllCwBtn.disabled = !hasPages;
  }
  if (ui.clearAllBtn) {
    ui.clearAllBtn.disabled = !hasPages;
  }

  if (hasPages) {
    ui.dropZone?.classList.add('compact');
    ui.pageNumberPanel?.classList.remove('hidden');
    ui.workspaceInfoBar?.classList.remove('hidden');
    ui.workspaceSection?.classList.remove('hidden');
  } else {
    ui.dropZone?.classList.remove('compact');
    ui.pageNumberPanel?.classList.add('hidden');
    ui.workspaceInfoBar?.classList.add('hidden');
    ui.workspaceSection?.classList.add('hidden');
  }

  refreshAllPageOrderAndIndicators();
}

/**
 * どのページからも参照されなくなった元PDFデータをメモリから解放する
 */
function cleanupUnusedSourceFiles() {
  const usedIds = new Set(
    appState.pageList
      .filter((item) => item.sourceFileId)
      .map((item) => item.sourceFileId)
  );
  for (const [fileId, entry] of appState.sourceFiles.entries()) {
    if (!usedIds.has(fileId)) {
      if (entry.pdfJsDoc && typeof entry.pdfJsDoc.destroy === 'function') {
        entry.pdfJsDoc.destroy().catch(() => {});
      }
      appState.sourceFiles.delete(fileId);
    }
  }
}

/**
 * File オブジェクトから ArrayBuffer を読み込む
 * @param {File} file - 読み込むファイル
 * @returns {Promise<ArrayBuffer>}
 */
function readFileAsArrayBuffer(file) {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(new Error('ファイルの読み込みに失敗しました。'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 指定された pageId のカードサムネイル・ステータスバッジ・ページ番号インジケーターを再描画する
 * @param {string} pageId - 対象ページのID
 */
async function refreshSinglePageCard(pageId) {
  const orderIndex = appState.pageList.findIndex((item) => item.id === pageId);
  if (orderIndex === -1 || !ui.pageGrid) {
    return;
  }
  const pageItem = appState.pageList[orderIndex];
  const sourceEntry = pageItem.sourceFileId
    ? appState.sourceFiles.get(pageItem.sourceFileId)
    : null;

  const cardElement = ui.pageGrid.querySelector(
    `.page-card[data-page-id="${CSS.escape(pageId)}"]`
  );
  if (!cardElement) {
    return;
  }

  const canvas = cardElement.querySelector('.thumbnail-canvas');
  if (canvas) {
    await renderThumbnailCanvas(
      pageItem,
      sourceEntry ? sourceEntry.pdfJsDoc : null,
      canvas
    );
  }
  updateCardStatusBadges(cardElement, pageItem);
  updateCardPageNumberIndicator(
    cardElement,
    pageItem,
    appState.pageNumberConfig,
    orderIndex,
    appState.pageList.length,
    appState.pageList
  );
}

/**
 * 単一ページを左（-90°）または右（+90°）に回転する
 * @param {string} pageId - 対象ページのID
 * @param {-90 | 90} deltaAngle - 回転角度 (-90 または +90)
 */
async function handleRotatePage(pageId, deltaAngle) {
  if (appState.isBusy) {
    return;
  }
  const pageItem = appState.pageList.find((item) => item.id === pageId);
  if (!pageItem) {
    return;
  }

  pageItem.rotation = normalizeRotation((pageItem.rotation || 0) + deltaAngle);
  if (Array.isArray(pageItem.edits) && pageItem.edits.length > 0) {
    pageItem.edits =
      deltaAngle < 0
        ? rotateEditsCounterClockwise90(pageItem.edits)
        : rotateEditsClockwise90(pageItem.edits);
  }

  await refreshSinglePageCard(pageId);
}

/**
 * 単一ページをリストから除外（削除）する
 * @param {string} pageId - 対象ページのID
 */
function handleDeletePage(pageId) {
  if (appState.isBusy) {
    return;
  }
  const targetIndex = appState.pageList.findIndex((item) => item.id === pageId);
  if (targetIndex === -1) {
    return;
  }

  appState.pageList.splice(targetIndex, 1);

  if (ui.pageGrid) {
    const cardElement = ui.pageGrid.querySelector(
      `.page-card[data-page-id="${CSS.escape(pageId)}"]`
    );
    if (cardElement) {
      cardElement.remove();
    }
  }

  cleanupUnusedSourceFiles();
  syncWorkspaceUiState();
}

/**
 * 指定ページの拡大編集モーダルを開く
 * @param {string} pageId - 対象ページのID
 */
function handleOpenPageEditor(pageId) {
  if (appState.isBusy) {
    return;
  }
  const orderIndex = appState.pageList.findIndex((item) => item.id === pageId);
  if (orderIndex === -1) {
    return;
  }

  const pageItem = appState.pageList[orderIndex];
  const sourceEntry = pageItem.sourceFileId
    ? appState.sourceFiles.get(pageItem.sourceFileId)
    : null;

  openPageEditorModal(
    pageItem,
    orderIndex,
    sourceEntry ? sourceEntry.pdfJsDoc : null,
    async (updatedId) => {
      // モーダル内で個別ページ番号設定が変更された場合、まだ全体がOFFで個別位置が選ばれていたら自動ON
      if (
        pageItem.pageNumberOverride &&
        pageItem.pageNumberOverride !== 'inherit' &&
        pageItem.pageNumberOverride !== 'hidden' &&
        !appState.pageNumberConfig.enabled
      ) {
        appState.pageNumberConfig.enabled = true;
        if (ui.pageNumEnabled) {
          ui.pageNumEnabled.checked = true;
        }
      }
      await refreshSinglePageCard(updatedId);
      refreshAllPageOrderAndIndicators();
    }
  );
}

/**
 * カード上のページ番号個別設定ドロップダウンが変更されたときの処理
 * @param {string} pageId - 対象ページのID
 * @param {string} overrideValue - 選択された設定値
 */
function handlePageNumOverrideChange(pageId, overrideValue) {
  const pageItem = appState.pageList.find((item) => item.id === pageId);
  if (!pageItem) {
    return;
  }
  pageItem.pageNumberOverride = overrideValue || 'inherit';

  // 個別設定が操作された際、全体トグルがまだOFFであれば自動でONにして視覚フィードバックを提供する
  if (overrideValue !== 'inherit' && !appState.pageNumberConfig.enabled) {
    appState.pageNumberConfig.enabled = true;
    if (ui.pageNumEnabled) {
      ui.pageNumEnabled.checked = true;
    }
  }

  refreshAllPageOrderAndIndicators();
}

/**
 * カード生成用の共通コールバックオブジェクトを取得する
 */
function getCardCallbacks() {
  return {
    onRotateCcw: (id) => handleRotatePage(id, -90),
    onRotateCw: (id) => handleRotatePage(id, 90),
    onInsertBlankAfter: (id) => handleInsertBlankPageAfter(id),
    onDelete: handleDeletePage,
    onEdit: handleOpenPageEditor,
    onPageNumOverrideChange: handlePageNumOverrideChange
  };
}

/**
 * 選択されている用紙サイズモードに基づいて空白ページの幅・高さ・ラベルを決定する
 * @param {number} insertIndex - 挿入予定のインデックス
 * @returns {{ width: number, height: number, paperLabel: string }}
 */
function resolveBlankPageSize(insertIndex) {
  const sizeMode = ui.blankPageSizeSelect?.value || 'match-prev';

  if (sizeMode === 'a4-portrait') {
    return {
      width: PAPER_SIZES['a4-portrait'].width,
      height: PAPER_SIZES['a4-portrait'].height,
      paperLabel: 'A4 縦'
    };
  }
  if (sizeMode === 'a4-landscape') {
    return {
      width: PAPER_SIZES['a4-landscape'].width,
      height: PAPER_SIZES['a4-landscape'].height,
      paperLabel: 'A4 横'
    };
  }

  // 'match-prev': 直前のページ（先頭挿入時は最初のページ）の表示サイズに合わせる
  const refPage =
    insertIndex > 0
      ? appState.pageList[insertIndex - 1]
      : appState.pageList[0] || null;

  if (refPage) {
    const { width, height } = getEffectivePageDimensions(refPage);
    return {
      width,
      height,
      paperLabel: `${Math.round(width)}×${Math.round(height)}`
    };
  }

  // ページがまだ1枚もない場合はA4縦をデフォルトとする
  return {
    width: PAPER_SIZES['a4-portrait'].width,
    height: PAPER_SIZES['a4-portrait'].height,
    paperLabel: 'A4 縦'
  };
}

/**
 * 指定したインデックス位置に空白ページを挿入する
 * @param {number} insertIndex - 挿入先インデックス (0 〜 pageList.length)
 */
async function insertBlankPageAtIndex(insertIndex) {
  if (appState.isBusy || !ui.pageGrid) {
    return;
  }

  const clampedIndex = Math.max(
    0,
    Math.min(appState.pageList.length, insertIndex)
  );
  const { width, height, paperLabel } = resolveBlankPageSize(clampedIndex);

  appState.pageSequence += 1;
  const blankPageItem = {
    id: `page_blank_${appState.pageSequence}_${Date.now()}`,
    type: 'blank',
    sourceFileId: null,
    fileName: '空白ページ',
    pageIndex: null,
    width,
    height,
    paperLabel,
    originalRotation: 0,
    rotation: 0,
    edits: [],
    pageNumberOverride: 'inherit'
  };

  appState.pageList.splice(clampedIndex, 0, blankPageItem);
  ui.workspaceSection?.classList.remove('hidden');

  const cardElement = createPageCardElement(
    blankPageItem,
    clampedIndex,
    getCardCallbacks()
  );

  // DOM上の該当位置に挿入
  const existingCards = ui.pageGrid.querySelectorAll('.page-card');
  if (clampedIndex < existingCards.length) {
    ui.pageGrid.insertBefore(cardElement, existingCards[clampedIndex]);
  } else {
    ui.pageGrid.appendChild(cardElement);
  }

  const canvas = cardElement.querySelector('.thumbnail-canvas');
  if (canvas) {
    await renderThumbnailCanvas(blankPageItem, null, canvas);
  }

  refreshIcons();
  syncWorkspaceUiState();
  showToast(
    `#${clampedIndex + 1} に空白ページ（${paperLabel}）を挿入しました。`,
    'info'
  );
}

/**
 * 指定したカードの直後に空白ページを挿入する
 * @param {string} targetPageId - 基準となるカードのページID
 */
async function handleInsertBlankPageAfter(targetPageId) {
  const idx = appState.pageList.findIndex((item) => item.id === targetPageId);
  const insertIndex = idx === -1 ? appState.pageList.length : idx + 1;
  await insertBlankPageAtIndex(insertIndex);
}

/**
 * SortableJS によるドラッグ＆ドロップ並び替え完了時に内部ステート配列をDOM順序に同期する
 * @param {string[]} orderedPageIds - 新しいDOM順のページID配列
 */
function handleReorderPages(orderedPageIds) {
  if (!Array.isArray(orderedPageIds) || orderedPageIds.length === 0) {
    return;
  }

  const pageMap = new Map(appState.pageList.map((item) => [item.id, item]));
  const reorderedList = [];

  for (const id of orderedPageIds) {
    const found = pageMap.get(id);
    if (found) {
      reorderedList.push(found);
      pageMap.delete(id);
    }
  }

  for (const remaining of pageMap.values()) {
    reorderedList.push(remaining);
  }

  appState.pageList = reorderedList;
  syncWorkspaceUiState();
}

/**
 * 選択またはドロップされた複数のPDFファイルを読み込み、ページサムネイルを生成して一覧の末尾に追加する
 * @param {FileList | File[]} fileList - アップロードされたファイル一覧
 */
async function processUploadedFiles(fileList) {
  if (appState.isBusy || !fileList || fileList.length === 0) {
    return;
  }

  const files = Array.from(fileList).filter(
    (file) =>
      file.type === 'application/pdf' ||
      file.name.toLowerCase().endsWith('.pdf')
  );

  if (files.length === 0) {
    showToast('PDFファイル（.pdf）を選択してください。', 'error');
    return;
  }

  showLoading(
    'PDFファイルを読み込み中...',
    `${files.length}件のファイルを解析しています`,
    5
  );

  let addedPagesTotal = 0;
  let loadedFilesCount = 0;

  try {
    const parsedFileEntries = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      showLoading(
        'PDFファイルを解析中...',
        `${file.name} (${i + 1} / ${files.length})`,
        Math.round(((i + 0.5) / files.length) * 30)
      );

      try {
        const arrayBuffer = await readFileAsArrayBuffer(file);
        const pdfBytes = new Uint8Array(arrayBuffer);

        const { pageCount, pageRotations, pageSizes } =
          await inspectPdfDocument(pdfBytes);
        const pdfJsDoc = await loadPdfJsDoc(pdfBytes);

        appState.fileSequence += 1;
        const sourceFileId = `file_${appState.fileSequence}_${Date.now()}`;

        const sourceEntry = {
          id: sourceFileId,
          fileName: file.name,
          pdfBytes,
          pdfJsDoc,
          pageCount,
          pageRotations,
          pageSizes
        };

        appState.sourceFiles.set(sourceFileId, sourceEntry);
        parsedFileEntries.push(sourceEntry);
        loadedFilesCount += 1;
      } catch (fileErr) {
        console.error(`ファイル読み込みエラー (${file.name}):`, fileErr);
        showToast(`${file.name}: ${fileErr.message}`, 'error');
      }
    }

    const totalNewPages = parsedFileEntries.reduce(
      (sum, entry) => sum + entry.pageCount,
      0
    );

    if (totalNewPages === 0) {
      hideLoading();
      syncWorkspaceUiState();
      return;
    }

    ui.workspaceSection?.classList.remove('hidden');

    let renderedCount = 0;
    for (const sourceEntry of parsedFileEntries) {
      for (let pageIdx = 0; pageIdx < sourceEntry.pageCount; pageIdx++) {
        renderedCount += 1;
        const progressPercent =
          30 + Math.round((renderedCount / totalNewPages) * 70);
        showLoading(
          'ページサムネイルを生成中...',
          `${sourceEntry.fileName} - ページ ${pageIdx + 1} / ${sourceEntry.pageCount} (全体 ${renderedCount} / ${totalNewPages})`,
          progressPercent
        );

        appState.pageSequence += 1;
        const sizeInfo = sourceEntry.pageSizes?.[pageIdx] || {
          width: 595.28,
          height: 841.89
        };
        const pageItem = {
          id: `page_${appState.pageSequence}_${Date.now()}`,
          type: 'pdf',
          sourceFileId: sourceEntry.id,
          fileName: sourceEntry.fileName,
          pageIndex: pageIdx,
          width: sizeInfo.width,
          height: sizeInfo.height,
          originalRotation: sourceEntry.pageRotations[pageIdx] || 0,
          rotation: 0,
          edits: [],
          pageNumberOverride: 'inherit'
        };

        appState.pageList.push(pageItem);
        const orderIndex = appState.pageList.length - 1;

        const cardElement = createPageCardElement(
          pageItem,
          orderIndex,
          getCardCallbacks()
        );

        ui.pageGrid.appendChild(cardElement);

        const canvas = cardElement.querySelector('.thumbnail-canvas');
        if (canvas) {
          await renderThumbnailCanvas(
            pageItem,
            sourceEntry.pdfJsDoc,
            canvas
          );
        }

        addedPagesTotal += 1;
      }
    }

    refreshIcons();
    syncWorkspaceUiState();
    showToast(
      `${loadedFilesCount}件のPDF（計${addedPagesTotal}ページ）を追加しました。`,
      'success'
    );
  } catch (error) {
    console.error('PDF読み込み処理中の予期しないエラー:', error);
    showToast(`エラーが発生しました: ${error.message}`, 'error');
  } finally {
    hideLoading();
    if (ui.fileInput) {
      ui.fileInput.value = '';
    }
  }
}

/**
 * すべてのページを一括で左（-90°）または右（+90°）へ90度回転する
 * @param {-90 | 90} deltaAngle - 回転角度 (-90 または +90)
 */
async function handleRotateAllPages(deltaAngle) {
  if (appState.isBusy || appState.pageList.length === 0) {
    return;
  }

  const total = appState.pageList.length;
  const dirLabel = deltaAngle < 0 ? '左（反時計回り）' : '右（時計回り）';
  showLoading(`全ページを${dirLabel}へ回転中...`, `0 / ${total} ページ`, 0);

  try {
    for (let i = 0; i < total; i++) {
      const pageItem = appState.pageList[i];
      pageItem.rotation = normalizeRotation(
        (pageItem.rotation || 0) + deltaAngle
      );
      if (Array.isArray(pageItem.edits) && pageItem.edits.length > 0) {
        pageItem.edits =
          deltaAngle < 0
            ? rotateEditsCounterClockwise90(pageItem.edits)
            : rotateEditsClockwise90(pageItem.edits);
      }

      showLoading(
        `全ページを${dirLabel}へ回転中...`,
        `${i + 1} / ${total} ページを更新しています`,
        Math.round(((i + 1) / total) * 100)
      );
      await refreshSinglePageCard(pageItem.id);
    }
    showToast(`すべてのページを90度${dirLabel}に回転しました。`, 'info');
  } catch (error) {
    console.error('一括回転エラー:', error);
    showToast('回転処理中にエラーが発生しました。', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * すべてのページと読み込み済みファイルをクリアして初期状態に戻す
 */
function handleClearAllPages() {
  if (appState.isBusy || appState.pageList.length === 0) {
    return;
  }

  appState.pageList = [];
  if (ui.pageGrid) {
    ui.pageGrid.innerHTML = '';
  }

  cleanupUnusedSourceFiles();
  syncWorkspaceUiState();
  showToast('すべてのページをクリアしました。', 'info');
}

/**
 * 現在の並び順・空白ページ・回転・編集・通しページ番号設定でPDFを再構成してダウンロードする
 */
async function handleExportPdf() {
  if (appState.isBusy || appState.pageList.length === 0) {
    return;
  }

  showLoading(
    'PDFをエクスポート中...',
    'ページの再構成と描画を開始しています...',
    10
  );

  try {
    const pdfBytes = await buildExportPdf(
      appState.sourceFiles,
      appState.pageList,
      appState.pageNumberConfig,
      (current, total, statusText) => {
        const percent =
          total > 0
            ? Math.min(95, 10 + Math.round((current / total) * 85))
            : 50;
        showLoading('PDFをエクスポート中...', statusText, percent);
      }
    );

    showLoading('ダウンロードを準備中...', 'ファイルを生成しました', 100);
    const downloadedName = triggerPdfDownload(pdfBytes);
    showToast(`エクスポートが完了しました (${downloadedName})`, 'success');
  } catch (error) {
    console.error('PDFエクスポートエラー:', error);
    showToast(`エクスポートに失敗しました: ${error.message}`, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * 通しページ番号設定パネルのイベントをバインドする
 */
function bindPageNumberEvents() {
  ui.pageNumEnabled?.addEventListener('change', (event) => {
    appState.pageNumberConfig.enabled = Boolean(event.target.checked);
    if (appState.pageNumberConfig.enabled) {
      preloadJapaneseFont(appState.pageNumberConfig.fontFamily).catch(() => {});
    }
    refreshAllPageOrderAndIndicators();
  });

  const handleParamChange = () => {
    // 書式・フォント・サイズ・開始番号・表示位置を操作した場合は自動的にページ番号付与をONにする
    if (!appState.pageNumberConfig.enabled) {
      appState.pageNumberConfig.enabled = true;
      if (ui.pageNumEnabled) {
        ui.pageNumEnabled.checked = true;
      }
    }
    appState.pageNumberConfig.format = ui.pageNumFormat?.value || 'hyphen';
    appState.pageNumberConfig.fontFamily =
      ui.pageNumFont?.value || 'yu-mincho';
    appState.pageNumberConfig.fontSizePt = Math.max(
      6,
      Math.min(36, Number(ui.pageNumSize?.value) || 10.5)
    );
    appState.pageNumberConfig.startPage = Math.max(
      1,
      Number(ui.pageNumStartPage?.value) || 1
    );
    appState.pageNumberConfig.startNumber = Math.max(
      1,
      Number(ui.pageNumStart?.value) || 1
    );
    appState.pageNumberConfig.position =
      ui.pageNumPosition?.value || 'bottom-center';

    // 選択されたフォントをバックグラウンドで事前プリロード
    preloadJapaneseFont(appState.pageNumberConfig.fontFamily).catch(() => {});

    refreshAllPageOrderAndIndicators();
  };

  ui.pageNumFormat?.addEventListener('change', handleParamChange);
  ui.pageNumFont?.addEventListener('change', handleParamChange);
  ui.pageNumSize?.addEventListener('input', handleParamChange);
  ui.pageNumStartPage?.addEventListener('input', handleParamChange);
  ui.pageNumStart?.addEventListener('input', handleParamChange);
  ui.pageNumPosition?.addEventListener('change', handleParamChange);
}

/**
 * ファイル入力および画面全体のドラッグ＆ドロップイベントを設定する
 */
function bindFileUploadEvents() {
  const openFilePicker = () => {
    if (!appState.isBusy && ui.fileInput) {
      ui.fileInput.click();
    }
  };

  ui.addFileBtn?.addEventListener('click', openFilePicker);
  ui.dropZoneBtn?.addEventListener('click', (event) => {
    event.stopPropagation();
    openFilePicker();
  });
  ui.dropZone?.addEventListener('click', openFilePicker);

  ui.fileInput?.addEventListener('change', (event) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      processUploadedFiles(files);
    }
  });

  ui.dropZone?.addEventListener('dragover', (event) => {
    event.preventDefault();
    ui.dropZone.classList.add('drag-over');
  });
  ui.dropZone?.addEventListener('dragleave', () => {
    ui.dropZone.classList.remove('drag-over');
  });
  ui.dropZone?.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    ui.dropZone.classList.remove('drag-over');
    ui.globalDropOverlay?.classList.add('hidden');
    if (event.dataTransfer?.files?.length) {
      processUploadedFiles(event.dataTransfer.files);
    }
  });

  let dragDepth = 0;
  const isFileDragEvent = (event) => {
    const types = event.dataTransfer?.types;
    return types && Array.from(types).includes('Files');
  };

  window.addEventListener('dragenter', (event) => {
    if (!isFileDragEvent(event) || appState.isBusy) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    ui.globalDropOverlay?.classList.remove('hidden');
  });

  window.addEventListener('dragover', (event) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  });

  window.addEventListener('dragleave', (event) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      ui.globalDropOverlay?.classList.add('hidden');
    }
  });

  window.addEventListener('drop', (event) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    ui.globalDropOverlay?.classList.add('hidden');
    ui.dropZone?.classList.remove('drag-over');

    if (event.dataTransfer?.files?.length) {
      processUploadedFiles(event.dataTransfer.files);
    }
  });
}

/**
 * アプリケーション全体の初期化処理
 */
function initializeApp() {
  cacheAppDomElements();
  refreshIcons();

  if (ui.pageGrid) {
    appState.sortableInstance = initSortableGrid(
      ui.pageGrid,
      handleReorderPages
    );
  }

  initPageEditor();
  bindFileUploadEvents();
  bindPageNumberEvents();

  // 空白ページ追加ボタン（末尾に追加）
  ui.addBlankPageBtn?.addEventListener('click', () => {
    insertBlankPageAtIndex(appState.pageList.length);
  });

  // 一括左右回転・クリア・エクスポートボタン
  ui.rotateAllCcwBtn?.addEventListener('click', () =>
    handleRotateAllPages(-90)
  );
  ui.rotateAllCwBtn?.addEventListener('click', () => handleRotateAllPages(90));
  ui.clearAllBtn?.addEventListener('click', handleClearAllPages);
  ui.exportBtn?.addEventListener('click', handleExportPdf);

  syncWorkspaceUiState();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}
