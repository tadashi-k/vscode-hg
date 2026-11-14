import * as cp from 'child_process';
import * as vscode from 'vscode';

export function runHg(
    hgPath: string,
    cwd: string,
    args: string[],
    options: { stdin?: string } = {}
): Promise<string> {
    return new Promise((resolve, reject) => {
        const opts: cp.ExecFileOptionsWithStringEncoding = {
            cwd,
            maxBuffer: 10 * 1024 * 1024,
            encoding: 'utf8'
        };
        const proc = cp.execFile(hgPath, args, opts,
            (err, stdout, stderr) => {
                if (err) {
                    const msg = stderr?.trim() || err.message;
                    reject(new Error(msg));
                    return;
                }
                resolve(stdout);
            }
        );
        if (options.stdin) {
            proc.stdin?.end(options.stdin, 'utf8');
        }
    });
}

/** Hg status codes -> label/category mapping */
export interface HgStatus {
    code: string;        // M, A, R, C, !, ?, I
    path: string;        // repo-relative path with forward slashes
}

export function parseStatus(output: string): HgStatus[] {
    const result: HgStatus[] = [];
    for (const line of output.split('\n')) {
        if (!line.trim()) { continue; }
        const code = line[0];
        const path = line.slice(2).trim().replace(/\\/g, '/');
        if (code && path) {
            result.push({ code, path });
        }
    }
    return result;
}

export async function showHgError(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    // hg exits 1 for "no changes" after commit - not an error worth showing
    if (!/nothing changed/i.test(message)) {
        vscode.window.showErrorMessage(`Mercurial: ${message}`);
    }
}
