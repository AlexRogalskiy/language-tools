import ts from 'typescript';
import {
  CancellationToken,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag
} from 'vscode-languageserver';
import { Document, mapRangeToOriginal } from '../../../core/documents';
import { DiagnosticsProvider } from '../../interfaces';
import { LanguageServiceManager } from '../LanguageServiceManager';
import { convertRange, mapSeverity, toVirtualAstroFilePath } from '../utils';
import { DocumentFragmentSnapshot } from '../DocumentSnapshot';
import { isInGeneratedCode } from './utils';

type BoundaryTuple = [number, number];

interface BoundaryParseResults {
    script: BoundaryTuple[];
    markdown: BoundaryTuple[];
}

export class DiagnosticsProviderImpl implements DiagnosticsProvider {
  private readonly languageServiceManager: LanguageServiceManager;

    constructor(languageServiceManager: LanguageServiceManager) {
      this.languageServiceManager = languageServiceManager;
    }

    async getDiagnostics(
        document: Document,
        _cancellationToken?: CancellationToken
    ): Promise<Diagnostic[]> {
        if (
            (document.getFilePath()?.includes('/node_modules/') ||
                document.getFilePath()?.includes('\\node_modules\\')) &&
            // Sapper convention: Put stuff inside node_modules below src
            !(
                document.getFilePath()?.includes('/src/node_modules/') ||
                document.getFilePath()?.includes('\\src\\node_modules\\')
            )
        ) {
            // Don't return diagnostics for files inside node_modules. These are considered read-only (cannot be changed)
            // and in case of svelte-check they would pollute/skew the output
            return [];
        }

        const { lang, tsDoc } = await this.getLSAndTSDoc(document);
        const isTypescript = tsDoc.scriptKind === ts.ScriptKind.TSX;

        // Document preprocessing failed, show parser error instead
        if (tsDoc.parserError) {
            return [
                {
                    range: tsDoc.parserError.range,
                    severity: DiagnosticSeverity.Error,
                    source: isTypescript ? 'ts' : 'js',
                    message: tsDoc.parserError.message,
                    code: tsDoc.parserError.code
                }
            ];
        }

        const filePath = toVirtualAstroFilePath(tsDoc.filePath);

        const {
            script: scriptBoundaries,
            markdown: markdownBoundaries
        } = this.getTagBoundaries(lang, filePath);

        const syntaxDiagnostics = lang.getSyntacticDiagnostics(filePath);
        const suggestionDiagnostics = lang.getSuggestionDiagnostics(filePath);
        const semanticDiagnostics = lang.getSemanticDiagnostics(filePath).filter(d => {
            return (
                isNoWithinScript(scriptBoundaries, d)
            );
        });

        const diagnostics: ts.Diagnostic[] = [
            ...syntaxDiagnostics,
            ...suggestionDiagnostics,
            ...semanticDiagnostics
        ];

        const fragment = await tsDoc.getFragment();
        const sourceFile = lang.getProgram()?.getSourceFile(filePath);

        const isNoFalsePositiveInst = isNoFalsePositive();
        return diagnostics
            .filter(isNotGenerated(tsDoc.getText(0, tsDoc.getLength())))
            .map<Diagnostic>((diagnostic) => ({
                range: convertRange(tsDoc, diagnostic),
                severity: mapSeverity(diagnostic.category),
                source: isTypescript ? 'ts' : 'js',
                message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
                code: diagnostic.code,
                tags: getDiagnosticTag(diagnostic)
            }))
            .map(mapRange(fragment, document))
            .filter(diag => {
                return (
                    hasNoNegativeLines(diag) &&
                    isNoFalsePositiveInst(diag) &&
                    isNoJSXImplicitRuntimeWarning(diag) &&
                    isNoJSXMustHaveOneParent(diag) &&
                    isNoCantUseJSX(diag) &&
                    isNoCantEndWithTS(diag) &&
                    isNoSpreadExpected(diag) &&
                    isNoCantResolveJSONModule(diag) &&
                    isNoMarkdownBlockQuoteWithinMarkdown(sourceFile, markdownBoundaries, diag)
                );
            })
            .map(enhanceIfNecessary);
    }

    private async getLSAndTSDoc(document: Document) {
      return this.languageServiceManager.getTypeScriptDoc(document);
    }

    private getTagBoundaries(lang: ts.LanguageService, tsFilePath: string): BoundaryParseResults {
        const program = lang.getProgram();
        const sourceFile = program?.getSourceFile(tsFilePath);

        const boundaries: BoundaryParseResults = {
            script: [],
            markdown: []
        };

        if(!sourceFile) {
            return boundaries;
        }

        function findScript(parent: ts.Node) {
            ts.forEachChild(parent, node => {
                if(ts.isJsxElement(node)) {
                    let tagName = node.openingElement.tagName.getText();

                    switch(tagName) {
                        case 'script': {
                            ts.getLineAndCharacterOfPosition(sourceFile!, node.getStart());
                            boundaries.script.push([node.getStart(), node.getEnd()]);
                            break;
                        }
                        case 'Markdown': {
                            boundaries.markdown.push([node.getStart(), node.getEnd()]);
                            break;
                        }
                    }
                }
                findScript(node);
            });
        }

        findScript(sourceFile);
        return boundaries;
    }
}

function getDiagnosticTag(diagnostic: ts.Diagnostic): DiagnosticTag[] {
  const tags: DiagnosticTag[] = [];
  if (diagnostic.reportsUnnecessary) {
      tags.push(DiagnosticTag.Unnecessary);
  }
  if (diagnostic.reportsDeprecated) {
      tags.push(DiagnosticTag.Deprecated);
  }
  return tags;
}

function mapRange(
    fragment: DocumentFragmentSnapshot,
    _document: Document
): (value: Diagnostic) => Diagnostic {
    return (diagnostic) => {
        let range = mapRangeToOriginal(fragment, diagnostic.range);

        if (range.start.line < 0) {
            // Could be a props error?
            // From svelte
        }

        return { ...diagnostic, range };
    };
}

/**
 * In some rare cases mapping of diagnostics does not work and produces negative lines.
 * We filter out these diagnostics with negative lines because else the LSP
 * apparently has a hickup and does not show any diagnostics at all.
 */
function hasNoNegativeLines(diagnostic: Diagnostic): boolean {
    return diagnostic.range.start.line >= 0 && diagnostic.range.end.line >= 0;
}



function isNoFalsePositive() {
    return (diagnostic: Diagnostic) => {
        return (
            isNoJsxCannotHaveMultipleAttrsError(diagnostic)
        );
    };
}

/**
 * Jsx cannot have multiple attributes with same name,
 * but that's allowed for svelte
 */
function isNoJsxCannotHaveMultipleAttrsError(diagnostic: Diagnostic) {
    return diagnostic.code !== 17001;
}

function isNoJSXImplicitRuntimeWarning(diagnostic: Diagnostic) {
    return diagnostic.code !== 7016 && diagnostic.code !== 2792;
}

function isNoJSXMustHaveOneParent(diagnostic: Diagnostic) {
    return diagnostic.code !== 2657;
}

function isNoCantUseJSX(diagnostic: Diagnostic) {
    return diagnostic.code !== 17004 && diagnostic.code !== 6142;
}

function isNoCantEndWithTS(diagnostic: Diagnostic) {
    return diagnostic.code !== 2691;
}

function isNoSpreadExpected(diagnostic: Diagnostic) {
    return diagnostic.code !== 1005;
}

function isWithinBoundaries(boundaries: BoundaryTuple[], start: number): boolean {
    for(let [bstart, bend] of boundaries) {
        if(start > bstart && start < bend) {
            return true;
        }
    }
    return false;
}

function diagnosticIsWithinBoundaries(sourceFile: ts.SourceFile | undefined, boundaries: BoundaryTuple[], diagnostic: Diagnostic | ts.Diagnostic) {
    if('start' in diagnostic) {
        if(diagnostic.start == null) return false;
        return isWithinBoundaries(boundaries, diagnostic.start);
    }

    if(!sourceFile) return false;

    let startRange = (diagnostic as Diagnostic).range.start;
    let pos = ts.getPositionOfLineAndCharacter(sourceFile, startRange.line, startRange.character);
    return isWithinBoundaries(boundaries, pos);
}

function isNoWithinScript(boundaries: BoundaryTuple[], diagnostic: ts.Diagnostic) {
    return !diagnosticIsWithinBoundaries(undefined, boundaries, diagnostic);
}

/**
 * This allows us to have JSON module imports.
 */
function isNoCantResolveJSONModule(diagnostic: Diagnostic) {
    return diagnostic.code !== 2732;
}

/**
 * This is for using > within a markdown component like:
 * <Markdown>
 *   > Blockquote here.
 * </Markdown>
 */
function isNoMarkdownBlockQuoteWithinMarkdown(sourceFile: ts.SourceFile | undefined, boundaries: BoundaryTuple[], diagnostic: Diagnostic | ts.Diagnostic) {
    if(diagnostic.code !== 1382) {
        return true;
    }

    return !diagnosticIsWithinBoundaries(sourceFile, boundaries, diagnostic);
}

/**
 * Some diagnostics have JSX-specific nomenclature. Enhance them for more clarity.
 */
function enhanceIfNecessary(diagnostic: Diagnostic): Diagnostic {
    if (diagnostic.code === 2786) {
        return {
            ...diagnostic,
            message:
                'Type definitions are missing for this Svelte Component. ' +
                // eslint-disable-next-line max-len
                "It needs a class definition with at least the property '$$prop_def' which should contain a map of input property definitions.\n" +
                'Example:\n' +
                '  class ComponentName { $$prop_def: { propertyName: string; } }\n' +
                'If you are using Svelte 3.31+, use SvelteComponentTyped:\n' +
                '  import type { SvelteComponentTyped } from "svelte";\n' +
                '  class ComponentName extends SvelteComponentTyped<{propertyName: string;}> {}\n\n' +
                'Underlying error:\n' +
                diagnostic.message
        };
    }

    if (diagnostic.code === 2607) {
        return {
            ...diagnostic,
            message:
                'Element does not support attributes because ' +
                'type definitions are missing for this Svelte Component or element cannot be used as such.\n\n' +
                'Underlying error:\n' +
                diagnostic.message
        };
    }

    if (diagnostic.code === 1184) {
        return {
            ...diagnostic,
            message:
                diagnostic.message +
                '\nIf this is a declare statement, move it into <script context="module">..</script>'
        };
    }

    return diagnostic;
}

/**
 * Checks if diagnostic is not within a section that should be completely ignored
 * because it's purely generated.
 */
function isNotGenerated(text: string) {
    return (diagnostic: ts.Diagnostic) => {
        if (diagnostic.start === undefined || diagnostic.length === undefined) {
            return true;
        }
        return !isInGeneratedCode(text, diagnostic.start, diagnostic.start + diagnostic.length);
    };
}