const fs = require('fs');
const path = require('path');
const { getProxy } = require('runtime-js');

const PACKAGES_DIR = path.resolve(__dirname, '../');

// Handler central - JS puro, testável isoladamente
async function handleListPackages() {
    const entries = await fs.promises.readdir(PACKAGES_DIR, { withFileTypes: true });
    const packages = entries
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(dir => {
            const pkgPath = path.join(PACKAGES_DIR, dir.name, 'package.json');
            let pkgData = { name: dir.name, description: '', version: '' };
            try {
                const raw = fs.readFileSync(pkgPath, 'utf-8');
                pkgData = { ...pkgData, ...JSON.parse(raw) };
            } catch (e) {
                // package.json não existe ou inválido
            }
            return {
                id: dir.name,
                name: dir.name,
                description: pkgData.description || '',
                version: pkgData.version || ''
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    
    return packages;
}

async function handleListFiles(packageId) {
    const pkgPath = path.join(PACKAGES_DIR, packageId);
    const files = [];
    
    async function scanDir(dir, base = '') {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const fullPath = path.join(dir, entry.name);
            const relPath = base ? `${base}/${entry.name}` : entry.name;
            
            if (entry.isDirectory()) {
                await scanDir(fullPath, relPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name);
                const isCodeFile = ['.js', '.ts', '.svelte', '.json', '.md', '.prisma', '.html', '.css', '.yaml', '.yml'].includes(ext);
                if (isCodeFile) {
                    files.push({
                        path: relPath,
                        name: entry.name,
                        ext: ext.slice(1)
                    });
                }
            }
        }
    }
    
    await scanDir(pkgPath);
    return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function handleReadFile(packageId, filePath) {
    const fullPath = path.join(PACKAGES_DIR, packageId, filePath);
    const normalized = path.normalize(fullPath);
    
    // CORREÇÃO DE SEGURANÇA: Garante que termina com a barra do sistema operativo
    const safeBase = path.resolve(PACKAGES_DIR, packageId) + path.sep;
    if (!normalized.startsWith(safeBase) && normalized !== path.resolve(PACKAGES_DIR, packageId)) {
        throw new Error('Invalid path');
    }
    
    const content = await fs.promises.readFile(fullPath, 'utf-8');
    return { path: filePath, content };
}

async function handleWriteFile(packageId, filePath, content) {
    const fullPath = path.join(PACKAGES_DIR, packageId, filePath);
    const normalized = path.normalize(fullPath);
    
    // CORREÇÃO DE SEGURANÇA: Garante que termina com a barra do sistema operativo
    const safeBase = path.resolve(PACKAGES_DIR, packageId) + path.sep;
    if (!normalized.startsWith(safeBase) && normalized !== path.resolve(PACKAGES_DIR, packageId)) {
        throw new Error('Invalid path');
    }
    
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content, 'utf-8');
    return { path: filePath, success: true };
}

// Rotas expostas via CommonJS
module.exports = {
    routerListPackages(req, res) {
        /**
         * @register_router packages
         * @method GET
         */
        return handleListPackages();
    },

    routerListFiles(req, res) {
        /**
         * @register_router files
         * @method GET
         */
        const { package: packageId } = req.query;
        if (!packageId) {
            res.status(400);
            return { error: 'Missing package parameter' };
        }
        return handleListFiles(packageId);
    },

    routerReadFile(req, res) {
        /**
         * @register_router file/read
         * @method GET
         */
        const { package: packageId, path: filePath } = req.query;
        if (!packageId || !filePath) {
            res.status(400);
            return { error: 'Missing package or path parameter' };
        }
        return handleReadFile(packageId, filePath);
    },

    routerWriteFile(req, res) {
        /**
         * @register_router file/write
         * @method POST
         */
        const { package: packageId, path: filePath, content } = req.body;
        if (!packageId || !filePath || content === undefined) {
            res.status(400);
            return { error: 'Missing required fields' };
        }
        return handleWriteFile(packageId, filePath, content);
    },

    onBoot(payload, context) {
        /**
         * @register_hook boot
         */
        console.log('[code-editor] Package initialized');
    }
};