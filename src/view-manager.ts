import { App, MarkdownView, Editor, FrontMatterCache } from "obsidian";
import { OutType } from "src/settings";

export class ViewManager {
    app: App;

    constructor(app: App) {
        this.app = app;
    }

    async getSelection(editor?: Editor): Promise<string[] | null> {
        if (editor) {
            return [editor.getSelection()];
        }
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            return [activeView.editor.getSelection()];
        }
        return null;
    }

    async getTitle(): Promise<string[] | null> {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            return [activeView.file.basename];
        }
        return null;
    }

    async getFrontMatter(): Promise<string[] | null> {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            const file = activeView.file;
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Partial<FrontMatterCache>;
            if (frontmatter?.position) {
                delete frontmatter.position;
            }
            return [JSON.stringify(frontmatter)];
        }
        return null;
    }

    async getContent(): Promise<string[] | null> {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            // delete frontmatter
            let content = activeView.getViewData();
            const file = activeView.file;
            const frontmatter: FrontMatterCache | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
            if (frontmatter) {
                content = content.split('---').slice(2).join('---');
            }
            return [content];
        }
        return null;
    }

	async getCalloutContent(): Promise<string[] | null> {
		const content = await this.getContent();
		let contentList = [];
		if (content && content[0]) {
			const regex = /> \[!\w+\] #new-highlight\n>([^]+?)(?=\n>\n|\n*$)/g;
			let match;
			while ((match = regex.exec(content[0])) !== null) {
			  contentList.push(match[1]);
			}
			return contentList;
		}
		return null;
	}

    async getTags(filterRegex?: string): Promise<string[] | null> {
        //@ts-ignore
        const tagsDict = this.app.metadataCache.getTags();
        let tags = Object.keys(tagsDict);
        if (!tags || tags.length == 0) return null;
        // remove #
        tags = tags.map((tag) => tag.replace(/^#/, ''));
        // filter
        if (filterRegex) {
            return tags.filter((tag) => RegExp(filterRegex).test(tag));
        }
        return tags;
    }

    async insertAtFrontMatter(key: string, value: string, overwrite = false, prefix = '', suffix = ''): Promise<void> {
        value = `${prefix}${value}${suffix}`;
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        
        if (activeView) {
            const file = activeView.file;
            await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                frontmatter = frontmatter || {};

                if (frontmatter[key] && !overwrite) {
                    // add value as list element if exist
                    if (Array.isArray(frontmatter[key])) {
                        frontmatter[key].push(value);
                    } else {
                        frontmatter[key] = [frontmatter[key], value];
                    }
                } else {
                    // overwrite
                    frontmatter[key] = value;
                }
            });
        }
    }

    async insertAtTitle(value: string, overwrite = false, prefix = '', suffix = ''): Promise<void> {
        value = `${prefix}${value}${suffix}`;
        const file = this.app.workspace.getActiveFile();
        if (!file) return; 
        let newName = file.basename;
        if (overwrite) {
            newName = `${value}`;
        } else {
            newName = `${newName} ${value}`;
        }
        newName = newName.replace(/[\"\/<>:\|?\"]/g, ''); // for window file name
        // @ts-ignore
        const newPath = file.getNewPathAfterRename(newName)
        await this.app.fileManager.renameFile(file, newPath);
    }

    async insertAtCursor(value: string, overwrite = false): Promise<void> {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        
        if (activeView) {
            const editor = activeView.editor;
            const selection = editor.getSelection();
            if (selection && !overwrite) {
                // replace selection
                editor.setSelection(editor.getCursor('to'));
            }
            // overwrite
            editor.replaceSelection(value);
        }
    }

    async insertAtContentTop(value: string): Promise<void> {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        
        if (activeView) {
            const editor = activeView.editor;
            const file = activeView.file;
            const sections = this.app.metadataCache.getFileCache(file)?.sections;
            
            // get the line after frontmatter
            let topLine = 0; 
            if (sections && sections[0].type == "yaml") {
                topLine = sections[0].position.end.line + 1;
            }

            // replace top of the content
            editor.setCursor({line: topLine, ch: 0});
            editor.replaceSelection(`${value}\n`);
        }
    }

    async insertAtCalloutTop(callout: string, tags: string): Promise<void> {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (!activeView) return;

		const editor = activeView.editor;
		const fileContent = editor.getValue();  // Get the current content of the file
        
		// Regular expression to find the specific callout with #new-highlight and the specified callout content     
		const regex = new RegExp(`(> \\[!\\w+\\] #new-highlight)\\s*>\\s*(${callout.replace(/[-\/\\^$.*+?()[\]{}|]/g, '\\$&')})(?=\\s*>|\\s*$)`, 'g');

		const match = regex.exec(fileContent);

		if (match) {
			const matchStartIndex = match.index;

			// Calculate the insertion index (after #new-highlight)
			const insertionIndex = matchStartIndex + match[1].length;

			// Convert the insertion index to editor line/character position
			const position = editor.offsetToPos(insertionIndex);

			// Move the cursor to that position and insert the tags
			editor.setCursor(position);
			editor.replaceSelection(`${tags}`);
		}
    }

    preprocessOutput(value: string, outType: OutType, prefix = '', suffix = ''): string {
        let output = '';
        if (outType == OutType.Tag) {
            output = `${prefix}${value}${suffix}`;
            output = output.replace(/ /g, "_");
            output = `#${output}`;
        }
        else if (outType == OutType.Wikilink) output = `[[${prefix}${value}${suffix}]]`;
        return output
    }
}
