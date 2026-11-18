import { addLoader, removeLoader } from "./loaders.js";
import { Icons } from "./lib/Icons.js";
import { Colors } from "./lib/Colors.js";
import { getFiles, getProjectName, getSelectedFile } from "./files.js";
import { editorState, interfaceState } from "./app.js";
import {
    consoleShown,
    memoryShown,
    registersShown,
    vm,
} from "./virtual-machine.js";
import { getFromStorage } from "./utils.js";
import { appConfig } from "./app-config.js";
import { getSelectedInstructionAddresses } from "./editors.js";
import { getMemoryIntervals, setGranularTooltips } from "./intervals.js";
import { possibleOptions } from "./settings.js";
import {
    drawMemoryMap,
    drawMemoryMapConnections,
    watchMemoryScroll,
} from "./memorymap.js";
import { scrollConsoleToBottom, watchingConsole } from "./console.js";
import {
    adjustBinaryWidth,
    updateTagsOverflowClasses,
    updateTagsWidth,
} from "./style.js";

declare const ejs: any;
(window as any).ejs = ejs;

export function getContext() {
    // the memory intervals and the selected addresses are costly to compute for big programs:
    // compute them only if a template uses them (at most once per context)
    let memoryIntervals: ReturnType<typeof getMemoryIntervals> | undefined;
    let selectedInstructionAddresses: number[] | undefined;
    return {
        projectName: getProjectName(),
        files: getFiles(),
        selectedFile: getSelectedFile(),
        interfaceState: interfaceState,
        editorState: editorState,
        /** currently set options*/
        settings: getFromStorage("local", "settings"),
        /** possible options as defined in settings.ts*/
        possibleOptions: possibleOptions,
        get memoryIntervals() {
            if (!memoryIntervals) memoryIntervals = getMemoryIntervals();
            return memoryIntervals;
        },
        memoryShown: memoryShown,
        consoleShown: consoleShown,
        registersShown: registersShown,
        get selectedInstructionAddresses() {
            if (!selectedInstructionAddresses)
                selectedInstructionAddresses = getSelectedInstructionAddresses();
            return selectedInstructionAddresses;
        },
        vm: vm,
        appConfig: appConfig,
    };
}

export async function render(
    id: string,
    templatePath: string,
    ctx: any = undefined,
    showLoaders: boolean = true,
) {
    if (showLoaders) addLoader(`render: ${id}`);
    if (!ctx) ctx = getContext();

    const element = document.getElementById(id);
    if (!element) throw new Error(`No element found by Id: ${id}`);

    // in memory save the scroll of the tables and restore it
    let scrollTop;
    if (id === "memory" && memoryShown)
        scrollTop = document
            .getElementById("memory")
            ?.querySelector(".component")?.scrollTop;

    element.innerHTML = await renderTemplate(templatePath, ctx);

    if (showLoaders) removeLoader(`render: ${id}`);
    // Post rendering logic and redraws
    if (id === "memory" || id === "registers") {
        adjustBinaryWidth();
    }
    if (id === "memory" || id === "app") {
        if (memoryShown) {
            // restore scroll
            const tables = document
                .getElementById("memory")
                ?.querySelector(".component");
            if (scrollTop && tables && memoryShown)
                tables.scrollTop = scrollTop;

            drawMemoryMapConnections();
            updateTagsWidth(ctx.vm);
        }
        drawMemoryMap();
        watchMemoryScroll();
        setGranularTooltips();
        updateTagsOverflowClasses();
    } else if (id === "console" && vm.console.state === "waitingInput") {
        const consoleInput = document.getElementById("console-input");
        if (consoleInput) {
            consoleInput.focus();
        }
        watchingConsole();
        scrollConsoleToBottom();
    }
}

(window as any).renderTemplate = renderTemplate;

type CompiledTemplate = (data: any) => Promise<string>;
/**Templates are fetched and compiled only once*/
const compiledTemplates = new Map<string, Promise<CompiledTemplate>>();

function getCompiledTemplate(templatePath: string): Promise<CompiledTemplate> {
    let compiled = compiledTemplates.get(templatePath);
    if (!compiled) {
        compiled = fetch(`templates/${templatePath}`)
            .then((res) => {
                if (!res.ok) {
                    throw new Error(
                        `No template found: "templates/${templatePath}"`,
                    );
                }
                return res.text();
            })
            .then(
                (template) =>
                    ejs.compile(template, { async: true }) as CompiledTemplate,
            );
        // don't cache failures, allowing to retry
        compiled.catch(() => compiledTemplates.delete(templatePath));
        compiledTemplates.set(templatePath, compiled);
    }
    return compiled;
}

async function renderTemplate(templatePath: string, ctx: any = undefined) {
    addLoader(`renderTemplate: ${templatePath}`);
    if (!ctx) ctx = getContext();
    const template = await getCompiledTemplate(templatePath);
    const data = { ctx, Icons, Colors };
    const result = await template(data);
    removeLoader(`renderTemplate: ${templatePath}`);
    return result;
}
