/**
 * 必须在其他 bridge 模块之前 import 的副作用模块：
 * preload 里所有模块都直接用全局 console，尽早替换才能覆盖启动日志。
 */
import { installConsoleFilter } from './console-filter.js';

installConsoleFilter();
