// ==UserScript==
// @name         立创PCB网页下单懒人助手
// @namespace    http://tampermonkey.net/
// @version      1.3.3
// @description  PCB网页下单懒人助手
// @author       Lx
// @match        https://www.jlc.com/newOrder**
// @icon         https://www.google.com/s2/favicons?sz=64&domain=jlc.com
// @require      https://update.greasyfork.org/scripts/446666/1389793/jQuery%20Core%20minified.js
// @grant none
// @license      MIT
// @homepageURL  https://github.com/haoduck/jlc_tool
// @supportURL   https://github.com/haoduck/jlc_tool/issues
// @updateURL    https://fastly.jsdelivr.net/gh/haoduck/jlc_tool@main/js/%E7%AB%8B%E5%88%9BPCB%E7%BD%91%E9%A1%B5%E4%B8%8B%E5%8D%95%E6%87%92%E4%BA%BA%E5%8A%A9%E6%89%8B.js
// @downloadURL  https://fastly.jsdelivr.net/gh/haoduck/jlc_tool@main/js/%E7%AB%8B%E5%88%9BPCB%E7%BD%91%E9%A1%B5%E4%B8%8B%E5%8D%95%E6%87%92%E4%BA%BA%E5%8A%A9%E6%89%8B.js
// ==/UserScript==


const DEBUG = true;

/**
 * 调试日志（排查用，控制台过滤「懒人助手」即可）
 */
const dbg = (...args) => {
    if (DEBUG) {
        console.log('%c[懒人助手]', 'color:#0a0', ...args);
    }
}

/**
 * 延迟方法
 * @param time
 */
const awaitTime = (time) => {
    return new Promise((resolve, reject) => {
        let tid = setTimeout(() => {
            clearTimeout(tid)
            resolve('ok')
        }, time)
    });
}

/**
 * 捕获异常，不影响后续执行
 * 点击类的脚本其实是不允许报错的，否则影响后续的逻辑执行
 * @param func
 */
const runIgnoreError = (func) => {
    try {
        // 检测并运行function
        func && func()
    } catch (error) {
        console.error(error);
    }
}

/**
 * 定时任务封装
 * @param {*} taskFunc 任务函数
 * @param {*} successBoolFunc  成功条件（返回true/false 成功则移除定时任务）
 * @param {*} timeout  任务间隔时长（毫秒）
 */
const timerFunc = (taskFunc, successBoolFunc, timeout = 1000) => {
    var _timer_ = setInterval(() => {
        if (successBoolFunc()) {
            clearInterval(_timer_);
            _timer_ = null;
        } else {
            runIgnoreError(() => taskFunc && taskFunc());
        }
    }, timeout);
}

/**
 * 按文案找可见的可点击元素
 * 查找顺序：可见弹窗内 -> 整页；同一个范围内先找 button/[role=button]，
 * 找不到再退化为「文本最短的可见容器」（即最内层元素，点击后事件会冒泡到父级的 @click）
 * @param {string} keyword 文案关键字（比较时忽略空白字符）
 * @param {boolean} exact 是否要求文案完全相等
 */
const findClickableByText = (keyword, exact = false) => {
    const key = keyword.replace(/\s/g, '');
    const matchText = (text) => {
        const str = text.replace(/\s/g, '');
        return exact ? str === key : str.indexOf(key) > -1;
    };

    const searchIn = ($scope) => {
        const $btns = $scope.find('button, [role="button"]').filter(function() {
            return $(this).is(':visible') && matchText($(this).text());
        });
        if ($btns.length > 0) {
            return $btns.first();
        }

        let $best = $();
        let bestLen = Infinity;
        // 先用 :contains 把候选压到极少数，再做逐元素判断
        // （真实页面 DOM 有几万个节点，逐个取 text() 会把页面卡死）
        const $candidates = /["\\]/.test(keyword) ?
            $scope.find('li, label, span, a, div') :
            $scope.find(`li:contains("${keyword}"), label:contains("${keyword}"), span:contains("${keyword}"), a:contains("${keyword}"), div:contains("${keyword}")`);
        $candidates.each(function() {
            const $this = $(this);
            if (!$this.is(':visible')) return;
            const text = $this.text();
            if (!matchText(text)) return;
            const len = text.replace(/\s/g, '').length;
            if (len < bestLen) {
                bestLen = len;
                $best = $this;
            }
        });
        return $best;
    };

    // 1. 优先在可见弹窗里找（弹窗里的元素基本都是目标，且范围小、扫描快）
    const $dialogs = $('div.el-dialog, div.jlc-modal, div[role="dialog"]').filter(function() {
        return $(this).is(':visible');
    });
    if ($dialogs.length > 0) {
        const $found = searchIn($dialogs.last());
        if ($found.length > 0) {
            return $found;
        }
    }

    // 2. 弹窗里没有，再整页找
    return searchIn($('body'));
}

/**
 * 轮询等待元素出现并点击
 * @param {Function} findFunc 返回 jQuery 对象
 * @param {number} maxWait 最长等待时间（毫秒）
 */
const waitAndClick = async(findFunc, maxWait = 5000, interval = 400) => {
    const deadline = Date.now() + maxWait;
    while (Date.now() < deadline) {
        const $el = findFunc();
        if ($el.length > 0 && $el.is(':visible')) {
            $el.click();
            return true;
        }
        await awaitTime(interval);
    }
    return false;
}

const start = async() => {

    // 工艺区域的公共状态：
    // 只有 4 层板才有「层压顺序」，而阻焊颜色要对这个判断做分支（4层绿 / 其它哑黑）
    const craftState = { layerDecided: false, is4Layer: false };

    // 轮询等待元素出现且可见
    const waitVisible = async(selector, maxWait, interval = 800) => {
        const deadline = Date.now() + maxWait;
        while (Date.now() < deadline) {
            const $el = $(selector);
            if ($el.length > 0 && $el.is(':visible')) return $el;
            await awaitTime(interval);
        }
        return $();
    };

    // 层压顺序（仅 4 层板）：
    // 1) pcbFileType_0 = 我是采购我不清楚这个选项
    // 2) cascadeStructure_0 = 无要求（免费）
    const applyLayerOptions = async() => {
        for (let i = 0; i < 3 && !$('#pcbFileType_0').hasClass('checked'); i++) {
            dbg(`层压顺序：点击「我是采购我不清楚这个选项」（第${i + 1}次）`);
            $('#pcbFileType_0').click();
            await awaitTime(800);
        }
        dbg('层压顺序：「我是采购我不清楚这个选项」 checked =', $('#pcbFileType_0').hasClass('checked'));

        const $cascade = await waitVisible('#cascadeStructure_0', 10000, 500);
        if ($cascade.length === 0) {
            dbg('层压顺序：没找到「无要求（免费）」选项');
            return;
        }
        for (let i = 0; i < 3 && !$('#cascadeStructure_0').hasClass('checked'); i++) {
            dbg(`层压顺序：点击「无要求（免费）」（第${i + 1}次）`);
            $('#cascadeStructure_0').click();
            await awaitTime(800);
        }
        dbg('层压顺序：「无要求（免费）」 checked =', $('#cascadeStructure_0').hasClass('checked'));
    };

    runIgnoreError(() => {
        // 长宽为空的话,重新加载页面
        timerFunc(() => {
            $('#pcbLengthInput').val('10');
            $('#pcbWidthInput').val('10');
        }, () => $('#pcbLengthInput').val() > 0, 1000);
    })

    if (location.href.indexOf('https://www.jlc.com/newOrder/#/pcb/pcbPlaceOrder') === 0 && !location.href.includes('edaUUID')) {
        window.location.replace(`${location.href}&edaUUID=55611fd7b14e48a18c37865f6b372d1d&from=eda-pro`);
    }

    runIgnoreError(() => {
        // 确认生产稿
        timerFunc(() => $('#confirmProductionFile_no').click(), () => $('#confirmProductionFile_no').hasClass('checked'), 1000);
    })

    runIgnoreError(async() => {
        timerFunc(async() => {
            // 数量选择
            if ($('#pcbNumberModal').length === 0) {
                $('#pcbNumber input[placeholder="数量"]').click();
                await awaitTime(1000 * 0.5)
                $('#pcbNumberModal li.numItem button:not([class*=checked]').each(function() {
                    if ($(this).text().replace(/[ \n]/g, '') === "5") {
                        $(this).click()
                    }
                })
            }
        }, () => $('#pcbNumber input[placeholder="数量"]').val() > 0, 1000);
    })

    runIgnoreError(async() => {
        // 包装 空白盒子
        timerFunc(() => $('#packType_white').click(), () => $('#packType_white').hasClass('checked'), 1000);
    })


    runIgnoreError(async() => {
        // 出货方式 单片资料单片出货
        timerFunc(() => $('#stencilType_one').click(), () => $('#stencilType_one').hasClass('checked'), 1000);
    })

    runIgnoreError(async() => {
        // 阻焊颜色：4 层板（有层压顺序）选「绿色」，其它板选「哑黑色」
        // 需要等层压顺序那块先判定完，否则可能误判板层数
        const deadline = Date.now() + 45000;
        while (!craftState.layerDecided && Date.now() < deadline) {
            await awaitTime(500);
        }
        const target = craftState.is4Layer ? '#adornColor_green' : '#adornColor_black';
        dbg('阻焊颜色：4 层板 =', craftState.is4Layer, '，目标 =', target);
        timerFunc(() => {
            if ($(target).length === 0) return;
            $(target).click();
        }, () => $(target).hasClass('checked'), 1000);
    })

    runIgnoreError(async() => {
        // 兜底：如果层压顺序比颜色区晚很多才渲染，前面会误判成非 4 层板选了哑黑，
        // 这里盯着它出现，一旦出现就改选绿色
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            if (craftState.is4Layer) return;
            const $ft = $('#pcbFileType_0').filter(':visible');
            if ($ft.length > 0) {
                craftState.is4Layer = true;
                craftState.layerDecided = true;
                dbg('层压顺序：稍后才出现，判定为 4 层板，颜色改选绿色，并补点层压选项');
                for (let i = 0; i < 10 && !$('#adornColor_green').hasClass('checked'); i++) {
                    $('#adornColor_green').click();
                    await awaitTime(1000);
                }
                await applyLayerOptions();
                return;
            }
            await awaitTime(1000);
        }
    })

    runIgnoreError(() => {
        // 焊盘喷镀 无铅OSP（免费）
        timerFunc(() => $('#adornPut_osp').click(), () => $('#adornPut_osp').hasClass('checked'), 1000);
    })

    runIgnoreError(() => {
        // 品质赔付服务 -> 按标准合同常规处理【仅赔偿PCB，但不负责PCBA移植及元器件赔偿】
        // 注意：主界面按钮文案是「合同」，弹出的确认弹窗文案是「合约」，故只用「按标准合」匹配
        const getStdGuaranteeBtn = () => {
            return $('#guaranteeService button').filter(function() {
                return $(this).text().replace(/\s/g, '').indexOf('按标准合') === 0;
            }).first();
        };

        // 弹窗里的确认按钮（排除主界面那个按钮）
        const getStdGuaranteeConfirmBtn = () => {
            return $('button').filter(function() {
                const $this = $(this);
                if ($this.closest('#guaranteeService').length > 0) return false;
                if (!$this.is(':visible')) return false;
                const text = $this.text().replace(/\s/g, '');
                return text.indexOf('按标准合') === 0 && text.indexOf('PCBA移植') > -1;
            }).first();
        };

        const isStdGuaranteeChecked = () => {
            const $btn = getStdGuaranteeBtn();
            return $btn.length > 0 && $btn.hasClass('checked');
        };

        timerFunc(() => {
            // 1. 有弹窗先点弹窗
            const $confirmBtn = getStdGuaranteeConfirmBtn();
            if ($confirmBtn.length > 0) {
                $confirmBtn.click();
                return;
            }
            // 2. 没有弹窗且未选中，点主按钮
            if (!isStdGuaranteeChecked()) {
                getStdGuaranteeBtn().click();
            }
        }, () => isStdGuaranteeChecked() && getStdGuaranteeConfirmBtn().length === 0, 1000);
    })

    runIgnoreError(() => {
        // 是否SMT贴片 不需要
        timerFunc(() => $('#isNeedOrderSMT_no').click(), () => $('#isNeedOrderSMT_no').hasClass('checked'), 2000);
    })

    runIgnoreError(() => {
        // 是否开钢网 不需要
        // 新版页面这块要等算价后才渲染，必须轮询点，不能只在加载时点一次
        timerFunc(() => $('#isNeedOrderSteel_no').click(), () => $('#isNeedOrderSteel_no').hasClass('checked'), 1000);
    })

    runIgnoreError(() => {
        // 确认订单方式：要「系统自动扣款并确认」，不要「手动确认订单」
        // 注意 isConfirmStatus_no（手动确认）默认就是 checked，不能拿它当完成条件
        timerFunc(() => {
            if ($('#isConfirmStatus_yes').length === 0) return;
            dbg('确认订单方式：点击「系统自动扣款并确认」');
            $('#isConfirmStatus_yes').click();
        }, () => $('#isConfirmStatus_yes').hasClass('checked'), 1000);
    })

    runIgnoreError(() => {
        // 不同交期订单一起发货(省运费)
        timerFunc(() => $('#bingdDelivery_2').click(), () => $('#bingdDelivery_2').hasClass('checked'), 1000);
    })

    runIgnoreError(() => {
        // 快递（选中标记在内层 span.radioIconNew 上，li 本身没有 checked）
        timerFunc(() => $('#express_yufu_0').click(),
            () => $('#express_yufu_0').find('.radioIconNew').hasClass('checked') || $('#express_yufu_0').hasClass('checked'), 1500);
    })

    runIgnoreError(async() => {
        await awaitTime(1000 * 3)
            // 不同交期订单一起发货(省运费)
        if (!$('#isNeedOrderSMT_confirm_no').hasClass('checked')) {
            $('#isNeedOrderSMT_confirm_no').click()
        }
    })

    runIgnoreError(async() => {
        // 板上加标志 -> 加嘉立创客编（免费） -> 指定位置添加(文件已有位置) -> 确认 -> 温馨提示「不确认生产稿」
        // 注意：新版页面里 banshangjiabiaozhi_1 直接就是 button（旧版外面还包了一层 div），
        // 且弹窗内元素没有稳定的 id/class，所以弹窗里一律按文案查找
        const addCodeBtn = () => $('#banshangjiabiaozhi_1');

        // 当前可见弹窗的文案（排查用）
        const visibleDialogText = () => {
            const $dlg = lastVisibleDialog();
            return $dlg.length === 0 ? '' : $dlg.text().replace(/\s+/g, ' ').trim();
        };

        // 最近一个可见弹窗
        const lastVisibleDialog = () => {
            const $dlgs = $('div.el-dialog, div.jlc-modal, div[role="dialog"]').filter(function() {
                return $(this).is(':visible');
            });
            return $dlgs.length > 0 ? $dlgs.last() : $();
        };

        // 在指定范围内找「确认/确定」按钮
        const confirmButtonsIn = ($scope) => {
            return $scope.find('button').filter(function() {
                const text = $(this).text().replace(/\s/g, '');
                return $(this).is(':visible') &&
                    (text === '确认' || text === '确定' || text.indexOf('确认') === 0);
            });
        };

        // 「确认」按钮：先在弹窗里找；弹窗里没有，再沿着「指定位置添加」逐级往上找，
        // 避免整页匹配误点到订单页级别的确认按钮
        const findConfirmBtn = () => {
            const $dlg = lastVisibleDialog();
            if ($dlg.length > 0) {
                const $btns = confirmButtonsIn($dlg);
                if ($btns.length > 0) return $btns.first();
                const $primary = $dlg.find('button.confirm-btn, button.primary, button.el-button--primary').filter(':visible').first();
                if ($primary.length > 0) return $primary;
            }

            const $opt = findPositionOption();
            if ($opt.length > 0) {
                let $parent = $opt.parent();
                for (let i = 0; i < 6 && $parent.length > 0; i++) {
                    const $btns = confirmButtonsIn($parent);
                    if ($btns.length > 0) return $btns.first();
                    $parent = $parent.parent();
                }
            }
            return $();
        };

        // 位置选项按钮（biaozhiweizhi_N）
        // 新版页面 id 直接挂在 button 上（如 biaozhiweizhi_2 = 指定位置添加(文件已有位置)）；
        // 旧版是 id 挂在 div 上、里面再包一层 button，两种结构都要兼容
        const posOptionBtns = () => {
            const $direct = $('button[id^="biaozhiweizhi_"]').filter(':visible');
            if ($direct.length > 0) return $direct;
            return $('div[id^="biaozhiweizhi_"]').filter(':visible').find('button').filter(':visible');
        };

        // 位置选项是否已经展开（用它判断「加嘉立创客编」是否已经点过，避免反复点击把区域又收起）
        const positionOptionVisible = () => posOptionBtns().length > 0;

        // 在若干按钮里挑出「指定位置添加(文件已有位置)」
        // 注意：这一组里有两个都以「指定位置添加」开头
        //   biaozhiweizhi_1 = 指定位置添加(立即添加)      ← 不要
        //   biaozhiweizhi_2 = 指定位置添加(文件已有位置)  ← 要这个
        // 所以优先级：文件已有位置 > 指定位置添加且非立即添加 > 整组最后一个（旧版结构）
        const pickPositionBtn = ($btns) => {
            if (!$btns || $btns.length === 0) return $();

            const $exists = $btns.filter(function() {
                return $(this).text().replace(/\s/g, '').indexOf('文件已有位置') > -1;
            });
            if ($exists.length > 0) return $exists.first();

            const $specified = $btns.filter(function() {
                const text = $(this).text().replace(/\s/g, '');
                return text.indexOf('指定位置添加') > -1 && text.indexOf('立即添加') === -1;
            });
            if ($specified.length > 0) return $specified.first();

            // 旧版结构里这组只有一个 button，最后一个就是「指定位置添加」；
            // 新版这里若只剩「立即添加」则宁可不点，避免选错
            return $btns.length > 1 ? $btns.last() : $();
        };

        // 「指定位置添加(文件已有位置)」选项：id 精确匹配 -> 按文案找
        const findPositionOption = () => {
            const $btn = pickPositionBtn(posOptionBtns());
            if ($btn.length > 0) return $btn;

            // 文案兜底也只认「文件已有位置」，避免又点到「立即添加」
            const $byText = findClickableByText('文件已有位置');
            if ($byText.length > 0) {
                dbg('位置选项按文案匹配：文件已有位置');
                return $byText;
            }

            const $specified = $('button').filter(function() {
                const $this = $(this);
                if (!$this.is(':visible')) return false;
                const text = $this.text().replace(/\s/g, '');
                return text.indexOf('指定位置添加') === 0 && text.indexOf('立即添加') === -1;
            });
            return $specified.length > 0 ? $specified.first() : $();
        };

        let running = false;
        let tryCount = 0;
        let buttonSeen = false;
        let waitLogged = false;
        let finished = false;
        let addBtnClickCount = 0;
        const MAX_TRY = 6;

        // 是否已经完成：
        // 1) 流程内部走完（最可靠）
        // 2) 兜底：位置选项已展开、且「指定位置添加」本身带 checked（说明之前就选过）
        // 注意：绝不能把「元素不存在」当成完成，否则页面还没渲染完就会提前收工；
        // 也不能在流程执行中（running）用 checked 判定，否则点完选项就误判完成、跳过确认那两步
        const isDone = () => finished || (!running && pickPositionBtn(posOptionBtns()).hasClass('checked'));

        const runFlow = async() => {
            if (running || finished) return;
            // 按钮还没渲染出来（页面在算价/加载），等下一轮，不计入重试次数
            if (addCodeBtn().length === 0) return;
            running = true;
            ++tryCount;
            try {
                // 1. 让「指定位置添加」选项展开
                // 已经展开就不再点，否则可能把展开的区域又收起来
                if (!positionOptionVisible() && addBtnClickCount < 4) {
                    ++addBtnClickCount;
                    dbg(`第${tryCount}次尝试：点击「加嘉立创客编」（第${addBtnClickCount}次）`);
                    addCodeBtn().click();
                }

                // 2. 点「指定位置添加(文件已有位置)」
                // 先用 id 前缀精确找（快），失败再退化为按文案找；
                // 这里给足等待时间，避免选项渲染慢一点就被判失败
                let posClicked = await waitAndClick(() => pickPositionBtn(posOptionBtns()), 7000, 500);
                if (!posClicked) {
                    posClicked = await waitAndClick(findPositionOption, 3000, 500);
                }
                if (!posClicked) {
                    dbg(`第${tryCount}次尝试：点不到「指定位置添加」，位置选项已展开 =`,
                        positionOptionVisible(), '，当前弹窗文案：', visibleDialogText().slice(0, 300));
                    return;
                }
                dbg('已点「指定位置添加」');
                await awaitTime(700);

                // 校验是否真的选上了（万一点击被吞）：没有弹窗拦着时再点一次
                const $picked = pickPositionBtn(posOptionBtns());
                if ($picked.length > 0 && !$picked.hasClass('checked') && lastVisibleDialog().length === 0) {
                    dbg('「指定位置添加」未变成选中态，再点一次');
                    $picked.click();
                    await awaitTime(700);
                }

                // 3. 同一页/弹窗点「确认」
                const okClicked = await waitAndClick(findConfirmBtn, 5000);
                dbg('点「确认」：', okClicked ? '成功' : `没找到，当前弹窗文案：${visibleDialogText().slice(0, 300)}`);
                await awaitTime(800);

                // 4. 温馨提示 点「不确认生产稿」
                const noClicked = await waitAndClick(() => {
                    const $byText = findClickableByText('不确认生产稿');
                    if ($byText.length > 0) return $byText;
                    return findClickableByText('不确认');
                }, 8000);
                dbg('点「不确认生产稿」：', noClicked ? '成功' : `没找到，当前弹窗文案：${visibleDialogText().slice(0, 300)}`);

                if (noClicked) {
                    finished = true;
                    dbg('客编流程完成');
                }
            } catch (error) {
                console.error(error);
            } finally {
                running = false;
            }
        };

        timerFunc(() => {
            // 按钮还没渲染出来就一直等（不消耗重试次数）
            if (addCodeBtn().length === 0) {
                if (!waitLogged) {
                    waitLogged = true;
                    dbg('客编：等待「加嘉立创客编」按钮渲染中…');
                }
                return;
            }
            if (!buttonSeen) {
                buttonSeen = true;
                dbg('客编：按钮已渲染， checked =', addCodeBtn().hasClass('checked'),
                    '，位置选项已展开 =', positionOptionVisible());
            }
            if (isDone()) return;
            if (tryCount >= MAX_TRY) {
                dbg(`客编：已尝试 ${tryCount} 次仍未成功，放弃（可在控制台手动执行）`);
                return;
            }
            runFlow();
        }, () => isDone() || (tryCount >= MAX_TRY && !running), 3000);
    })

    runIgnoreError(async() => {
        var tryCount = 0;
        const retryMaxCount = 3;
        // 获取优惠券数量
        var getCouponCount = () => {
            try {
                return parseInt(/\d+/g.exec($('#useCollarCoupon span.selectCoupon span:contains("张可用优惠券)")').text())[0]);
            } catch (error) {
                return -1;
            }
        };

        // 是否优惠券都不可用
        const isAllNotUse = () => $('div.el-dialog div.couponBox div[id*=collarCouponId_]').length === $('div.el-dialog div.couponBox div[id*=collarCouponId_]:contains("不可用")').length;
        timerFunc(async() => {
            // 选择优惠券按钮
            $('.selectCoupon').click();
            // 兜底判断
            if ($('div.el-dialog div.couponBox:contains("不可用")').length > 0) {
                await awaitTime(1000 * 0.5)
                    // 提交优惠券
                $("div.el-dialog button:contains(不使用优惠券)").click();
            } else {
                await awaitTime(1000 * 0.5)
                    // 默认选择第一张优惠券
                $('#collarCouponId_0').click()
                await awaitTime(1000 * 0.5)
                    // 提交优惠券
                $("div.el-dialog button:contains(使用优惠券):eq(1)").click();
            }
            ++tryCount;
        }, () => {
            return $('div#useCollarCoupon:contains("已选择")').length > 0 || getCouponCount() === 0 || tryCount === retryMaxCount || !isAllNotUse();
        }, 2500);
    })

    runIgnoreError(async() => {
        // 层压顺序：只有 4 层板才会出现这一项，没有就静默跳过
        // 等这块区域渲染出来。层压顺序和阻焊颜色在同一个工艺区，通常一起出现：
        // 如果阻焊颜色已经出现、再过 6 秒仍没有 pcbFileType_0，就判定为非 4 层板（不必干等 40 秒）
        const deadline = Date.now() + 40000;
        let colorSeenAt = 0;
        while (Date.now() < deadline) {
            const $ft = $('#pcbFileType_0');
            if ($ft.length > 0 && $ft.is(':visible')) break;
            if (colorSeenAt === 0) {
                const $c = $('#adornColor_black');
                if ($c.length > 0 && $c.is(':visible')) colorSeenAt = Date.now();
            }
            if (colorSeenAt > 0 && Date.now() - colorSeenAt > 6000) break;
            await awaitTime(500);
        }

        const $fileType = $('#pcbFileType_0').filter(':visible');
        if ($fileType.length === 0) {
            craftState.is4Layer = false;
            craftState.layerDecided = true;
            dbg('层压顺序：没出现「我是采购我不清楚这个选项」，按非 4 层板处理，跳过（阻焊颜色将选哑黑色）');
            return;
        }
        craftState.is4Layer = true;
        craftState.layerDecided = true;
        dbg('层压顺序：检测到 4 层板（阻焊颜色将选绿色）');

        await applyLayerOptions();
    })
}
$(window).on("load", start);