
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { SalesData, SortConfig, SortKey } from './types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

// --- Helper Functions ---

const LOCAL_STORAGE_KEY_DATA = 'erpSalesData';
const LOCAL_STORAGE_KEY_STOCK = 'erpInitialStock';
const LOW_STOCK_THRESHOLD = 10;

/**
 * Automatically calculates the minimum required initial stock for new products based on their transaction history.
 * This prevents validation errors for CSVs where initial stock wasn't manually set.
 * @param transactions - The list of new transactions from the CSV.
 * @param existingInitialStocks - The current map of manually set initial stocks.
 * @returns A map of inferred initial stocks for new products only.
 */
const inferInitialStocks = (transactions: SalesData[], existingInitialStocks: Record<string, number>): Record<string, number> => {
    const productTransactions: Record<string, SalesData[]> = {};

    // 1. Group transactions by product name
    for (const trans of transactions) {
        const name = trans.nama_produk;
        if (!productTransactions[name]) {
            productTransactions[name] = [];
        }
        productTransactions[name].push(trans);
    }

    const inferredStocks: Record<string, number> = {};

    // 2. For each product, find the minimum stock required to fulfill all sales
    for (const productName in productTransactions) {
        // Only infer for new products not already in the initial stock settings
        if (existingInitialStocks[productName] !== undefined) {
            continue;
        }

        const productTrans = productTransactions[productName].sort(
            (a, b) => new Date(a.tanggal).getTime() - new Date(b.tanggal).getTime()
        );

        let stockLevel = 0;
        let minStockLevel = 0;

        for (const trans of productTrans) {
            // We only care about sales for this calculation, as they reduce stock.
            stockLevel -= trans.jumlah_terjual;
            if (stockLevel < minStockLevel) {
                minStockLevel = stockLevel;
            }
        }
        
        // The absolute value of the lowest point is the minimum initial stock required.
        inferredStocks[productName] = Math.abs(minStockLevel);
    }

    return inferredStocks;
};


const processAndValidateData = (data: SalesData[], initialStocks: Record<string, number>): { processedData: SalesData[], error: string | null } => {
    // 1. Sort all transactions chronologically. This is the most crucial change.
    const sortedData = [...data].sort((a, b) => new Date(a.tanggal).getTime() - new Date(b.tanggal).getTime());
    
    // 2. Initialize current stock levels from the initial stock settings.
    const currentStocks = { ...initialStocks };
    const processedData: SalesData[] = [];

    // 3. Iterate through each transaction in chronological order.
    for (const trans of sortedData) {
        const productName = trans.nama_produk;

        // Ensure we have a starting stock value for every product encountered.
        if (currentStocks[productName] === undefined) {
            // This is a new product not in initial stock, so we assume it starts at 0 before this transaction.
            currentStocks[productName] = 0;
        }
        
        const stockBeforeTransaction = currentStocks[productName];
        let stockAfterTransaction = stockBeforeTransaction;

        const isStockAdjustment = trans.jumlah_terjual === 0;

        if (isStockAdjustment) {
            // A stock adjustment directly sets the stock to a new value specified in its 'stok_sisa' field.
            stockAfterTransaction = trans.stok_sisa;
        } else {
            // A sale reduces the stock.
            stockAfterTransaction = stockBeforeTransaction - trans.jumlah_terjual;
            
            // 4. Validate if the sale is possible.
            if (stockAfterTransaction < 0) {
                return { 
                    processedData: [], 
                    error: `Stok tidak mencukupi untuk "${productName}" pada tanggal ${trans.tanggal}. Stok saat itu: ${stockBeforeTransaction}, jumlah terjual: ${trans.jumlah_terjual}. Stok tidak boleh negatif.`
                };
            }
        }
        
        // 5. Update the master stock record for the next transaction.
        currentStocks[productName] = stockAfterTransaction;

        // 6. Create a new transaction object with the correctly calculated `stok_sisa`.
        processedData.push({
            ...trans,
            stok_sisa: stockAfterTransaction,
        });
    }

    return { processedData, error: null };
};


const parseCSV = (text: string): { data: SalesData[], error: string | null } => {
    try {
        const lines = text.trim().split('\n').filter(line => line.trim() !== '');
        if (lines.length < 2) {
          return { data: [], error: "File CSV kosong atau hanya berisi header." };
        }
        
        const header = lines[0].split(',').map(h => h.trim());
        const requiredHeaders: (keyof Omit<SalesData, 'id'>)[] = ['tanggal', 'nama_produk', 'jumlah_terjual', 'harga_beli', 'harga_jual', 'total_penjualan', 'total_biaya', 'laba', 'stok_sisa'];
        
        const missingHeaders = requiredHeaders.filter(rh => !header.includes(rh));
        if (missingHeaders.length > 0) {
            return { data: [], error: `Header CSV tidak valid. Kolom yang hilang: ${missingHeaders.join(', ')}` };
        }

        const data = lines.slice(1).map((line, index) => {
            const values = line.split(',').map(v => v.trim());
            const entry: any = {
                id: `id_csv_${Date.now()}_${Math.random()}_${index}`
            };
            header.forEach((h, i) => {
                const key = h as SortKey;
                const value = values[i];
                if (['jumlah_terjual', 'harga_beli', 'harga_jual', 'total_penjualan', 'total_biaya', 'laba', 'stok_sisa'].includes(key)) {
                    const numValue = parseFloat(value);
                    if (isNaN(numValue)) {
                        throw new Error(`Nilai tidak valid pada baris ${index + 2}, kolom '${key}'. Harap periksa file CSV Anda.`);
                    }
                    entry[key] = numValue;
                } else {
                    entry[key] = value;
                }
            });
            // For CSV, we ignore the stok_sisa column as it will be recalculated.
            return entry as SalesData;
        });
        return { data, error: null };
    } catch (e: any) {
        return { data: [], error: e.message || "Gagal memproses file CSV. Pastikan formatnya benar." };
    }
};

const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(value);
};

const formatNumber = (value: number) => {
    return new Intl.NumberFormat('id-ID').format(value);
};

const exportToCSV = (data: SalesData[], filename: string) => {
    if (data.length === 0) return;
    const header = Object.keys(data[0]).filter(k => k !== 'id').join(',');
    const rows = data.map(row => {
        const { id, ...rest } = row;
        return Object.values(rest).join(',');
    });
    const csvContent = [header, ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    if (link.href) {
        URL.revokeObjectURL(link.href);
    }
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};


// --- SVG Icons ---

const MoneyIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 6V5m0 14v-1m-7-7h14" />
    </svg>
);

const ChartBarIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
);

const StarIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.364 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.364-1.118L2.98 9.11c-.783-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
    </svg>
);

const ArchiveIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-1.414 1.414a1 1 0 01-1.414 0l-1.414-1.414a1 1 0 00-.707-.293H8m12 0a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7a2 2 0 002 2h2.586a1 1 0 00.707-.293l1.414-1.414a1 1 0 011.414 0l1.414 1.414a1 1 0 00.707.293H18a2 2 0 002-2z" />
    </svg>
);

const ChevronUpIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
);

const ChevronDownIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
);

// --- Components ---

const SummaryCard = ({ title, value, icon, color }) => (
    <div className="bg-white p-6 rounded-2xl shadow-lg flex items-center space-x-4">
        <div className={`p-3 rounded-full ${color}`}>
            {icon}
        </div>
        <div>
            <p className="text-slate-500 text-sm font-medium">{title}</p>
            <p className="text-2xl font-bold text-slate-800">{value}</p>
        </div>
    </div>
);

const ManualEntryForm = ({ onAddEntry, products, initialStocks }) => {
    const today = new Date().toISOString().split('T')[0];
    const [formData, setFormData] = useState({
        tanggal: today,
        nama_produk: '',
        jumlah_terjual: '',
        harga_beli: '',
        harga_jual: '',
        stok_sisa: '', // Used for stock adjustments
        entryType: 'sale' // 'sale' or 'adjustment'
    });
    const [error, setError] = useState('');

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
        setError('');
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        
        const isSale = formData.entryType === 'sale';
        
        const nama_produk = formData.nama_produk.trim();
        if (!nama_produk) {
            setError('Nama produk tidak boleh kosong.');
            return;
        }

        const jumlah_terjual = isSale ? parseFloat(formData.jumlah_terjual) : 0;
        const stok_sisa = isSale ? 0 : parseFloat(formData.stok_sisa); // For adjustments
        const harga_beli = isSale ? parseFloat(formData.harga_beli) : 0;
        const harga_jual = isSale ? parseFloat(formData.harga_jual) : 0;

        if (isSale) {
            if (isNaN(jumlah_terjual) || isNaN(harga_beli) || isNaN(harga_jual)) {
                setError('Pastikan semua kolom angka diisi dengan benar untuk penjualan.');
                return;
            }
            if (jumlah_terjual <= 0) {
                setError('Jumlah terjual harus lebih dari 0.');
                return;
            }
        } else {
            if (isNaN(stok_sisa)) {
                setError('Jumlah stok untuk penyesuaian harus berupa angka.');
                return;
            }
             if (stok_sisa < 0) {
                setError('Jumlah stok tidak boleh negatif.');
                return;
            }
        }

        const total_penjualan = isSale ? jumlah_terjual * harga_jual : 0;
        const total_biaya = isSale ? jumlah_terjual * harga_beli : 0;
        const laba = isSale ? total_penjualan - total_biaya : 0;

        const newEntry = {
            id: `id_manual_${Date.now()}_${Math.random()}`,
            tanggal: formData.tanggal,
            nama_produk,
            jumlah_terjual,
            harga_beli,
            harga_jual,
            total_penjualan,
            total_biaya,
            laba,
            stok_sisa: isSale ? 0 : stok_sisa, // Will be recalculated, but need a value for adjustment type
        };

        const addError = onAddEntry(newEntry);
        if (addError) {
            setError(addError);
        } else {
            // Reset form
            setFormData({
                tanggal: today,
                nama_produk: '',
                jumlah_terjual: '',
                harga_beli: '',
                harga_jual: '',
                stok_sisa: '',
                entryType: 'sale'
            });
        }
    };

    return (
        <div className="bg-slate-800 p-6 rounded-2xl shadow-lg">
            <h3 className="text-xl font-bold text-slate-100 mb-4">Input Data Manual</h3>
            <form onSubmit={handleSubmit}>
                {error && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg relative mb-4" role="alert">{error}</div>}
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {/* Date */}
                    <div>
                        <label htmlFor="tanggal" className="block text-sm font-medium text-slate-300 mb-1">Tanggal</label>
                        <input
                            type="date"
                            id="tanggal"
                            name="tanggal"
                            value={formData.tanggal}
                            onChange={handleChange}
                            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 text-white rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                            required
                        />
                    </div>

                    {/* Product Name */}
                    <div>
                        <label htmlFor="nama_produk" className="block text-sm font-medium text-slate-300 mb-1">Nama Produk (Baru atau Lama)</label>
                        <input
                            type="text"
                            id="nama_produk"
                            name="nama_produk"
                            list="product-list"
                            value={formData.nama_produk}
                            onChange={handleChange}
                            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 text-white placeholder-slate-400 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                            required
                        />
                        <datalist id="product-list">
                            {products.map(p => <option key={p} value={p} />)}
                        </datalist>
                    </div>

                    {/* Entry Type */}
                    <div>
                        <label htmlFor="entryType" className="block text-sm font-medium text-slate-300 mb-1">Jenis Input</label>
                        <select
                            id="entryType"
                            name="entryType"
                            value={formData.entryType}
                            onChange={handleChange}
                            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 text-white rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                        >
                            <option value="sale">Penjualan</option>
                            <option value="adjustment">Penyesuaian Stok</option>
                        </select>
                    </div>

                    {formData.entryType === 'sale' ? (
                        <>
                            {/* Jumlah Terjual */}
                            <div>
                                <label htmlFor="jumlah_terjual" className="block text-sm font-medium text-slate-300 mb-1">Jumlah Terjual</label>
                                <input
                                    type="number"
                                    id="jumlah_terjual"
                                    name="jumlah_terjual"
                                    value={formData.jumlah_terjual}
                                    onChange={handleChange}
                                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 text-white placeholder-slate-400 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                                    min="0"
                                />
                            </div>

                            {/* Harga Beli */}
                            <div>
                                <label htmlFor="harga_beli" className="block text-sm font-medium text-slate-300 mb-1">Harga Beli (per item)</label>
                                <input
                                    type="number"
                                    id="harga_beli"
                                    name="harga_beli"
                                    value={formData.harga_beli}
                                    onChange={handleChange}
                                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 text-white placeholder-slate-400 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                                    min="0"
                                />
                            </div>

                            {/* Harga Jual */}
                            <div>
                                <label htmlFor="harga_jual" className="block text-sm font-medium text-slate-300 mb-1">Harga Jual (per item)</label>
                                <input
                                    type="number"
                                    id="harga_jual"
                                    name="harga_jual"
                                    value={formData.harga_jual}
                                    onChange={handleChange}
                                    className="w-full px-3 py-2 bg-slate-700 border border-slate-600 text-white placeholder-slate-400 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                                    min="0"
                                />
                            </div>
                        </>
                    ) : (
                        // Stock Adjustment
                        <div>
                            <label htmlFor="stok_sisa" className="block text-sm font-medium text-slate-300 mb-1">Jumlah Stok Baru</label>
                            <input
                                type="number"
                                id="stok_sisa"
                                name="stok_sisa"
                                value={formData.stok_sisa}
                                onChange={handleChange}
                                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 text-white placeholder-slate-400 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                                min="0"
                            />
                        </div>
                    )}
                </div>
                
                <div className="mt-6">
                    <button type="submit" className="w-full bg-indigo-600 text-white font-bold py-2 px-4 rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors">
                        Tambah Data
                    </button>
                </div>
            </form>
        </div>
    );
};

const InitialStockManager = ({ initialStocks, onUpdateStocks }) => {
    const [stocks, setStocks] = useState(initialStocks);
    const [newProduct, setNewProduct] = useState('');
    const [newStock, setNewStock] = useState('');

    useEffect(() => {
        setStocks(initialStocks);
    }, [initialStocks]);

    const handleAddStock = () => {
        const productName = newProduct.trim();
        const stockAmount = parseInt(newStock, 10);
        if (productName && !isNaN(stockAmount) && stockAmount >= 0) {
            const updatedStocks = { ...stocks, [productName]: stockAmount };
            setStocks(updatedStocks);
            onUpdateStocks(updatedStocks);
            setNewProduct('');
            setNewStock('');
        }
    };
    
    const handleStockChange = (productName, value) => {
        const stockAmount = parseInt(value, 10);
        if (!isNaN(stockAmount) && stockAmount >= 0) {
            const updatedStocks = { ...stocks, [productName]: stockAmount };
            setStocks(updatedStocks);
            onUpdateStocks(updatedStocks);
        }
    };

    return (
        <div className="bg-white p-6 rounded-2xl shadow-lg">
            <h3 className="text-xl font-bold text-slate-800 mb-4">Kelola Stok Awal</h3>
            <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                {Object.keys(stocks).length > 0 ? Object.entries(stocks).map(([name, amount]) => (
                    <div key={name} className="flex items-center justify-between bg-slate-50 p-2 rounded-md">
                        <span className="font-medium text-slate-700">{name}</span>
                        <input 
                            type="number"
                            value={amount}
                            onChange={(e) => handleStockChange(name, e.target.value)}
                            className="w-24 text-right px-2 py-1 border border-slate-300 rounded-md"
                        />
                    </div>
                )) : <p className="text-slate-500 italic">Belum ada stok awal yang diatur.</p>}
            </div>
            <div className="flex gap-4 mt-4 pt-4 border-t border-slate-200">
                <input
                    type="text"
                    placeholder="Nama Produk Baru"
                    value={newProduct}
                    onChange={(e) => setNewProduct(e.target.value)}
                    className="flex-grow px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                />
                <input
                    type="number"
                    placeholder="Jumlah Stok Awal"
                    value={newStock}
                    onChange={(e) => setNewStock(e.target.value)}
                    className="w-40 px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                    min="0"
                />
                <button 
                    onClick={handleAddStock}
                    className="bg-indigo-600 text-white font-semibold px-4 py-2 rounded-md hover:bg-indigo-700 transition-colors"
                >
                    Tambah
                </button>
            </div>
        </div>
    );
};

const DataTable = ({ data, onSort, sortConfig, onDeleteRow }) => {
    const requestSort = (key: SortKey) => {
        let direction: 'ascending' | 'descending' = 'ascending';
        if (sortConfig && sortConfig.key === key && sortConfig.direction === 'ascending') {
            direction = 'descending';
        }
        onSort({ key, direction });
    };

    const getSortIcon = (key: SortKey) => {
        if (!sortConfig || sortConfig.key !== key) {
            return null;
        }
        return sortConfig.direction === 'ascending' ? <ChevronUpIcon /> : <ChevronDownIcon />;
    };

    const headers: { key: SortKey; label: string }[] = [
        { key: 'tanggal', label: 'Tanggal' },
        { key: 'nama_produk', label: 'Nama Produk' },
        { key: 'jumlah_terjual', label: 'Jml Terjual' },
        { key: 'harga_jual', label: 'Harga Jual' },
        { key: 'laba', label: 'Laba' },
        { key: 'stok_sisa', label: 'Stok Sisa' },
    ];

    return (
        <div className="bg-white p-6 rounded-2xl shadow-lg">
            <h3 className="text-xl font-bold text-slate-800 mb-4">Detail Data Penjualan</h3>
            <div className="overflow-x-auto">
                <table className="w-full text-sm text-left text-slate-500">
                    <thead className="text-xs text-slate-700 uppercase bg-slate-50">
                        <tr>
                            {headers.map(({ key, label }) => (
                                <th key={key} scope="col" className="px-6 py-3 cursor-pointer" onClick={() => requestSort(key)}>
                                    <div className="flex items-center">
                                        {label}
                                        <span className="ml-1">{getSortIcon(key)}</span>
                                    </div>
                                </th>
                            ))}
                            <th scope="col" className="px-6 py-3">Aksi</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.map((item) => (
                            <tr key={item.id} className="bg-white border-b hover:bg-slate-50">
                                <td className="px-6 py-4">{item.tanggal}</td>
                                <td className="px-6 py-4 font-medium text-slate-900 whitespace-nowrap">{item.nama_produk}</td>
                                <td className="px-6 py-4 text-right">{formatNumber(item.jumlah_terjual)}</td>
                                <td className="px-6 py-4 text-right">{formatCurrency(item.harga_jual)}</td>
                                <td className="px-6 py-4 text-right">{formatCurrency(item.laba)}</td>
                                <td className="px-6 py-4 text-right font-bold">{formatNumber(item.stok_sisa)}</td>
                                <td className="px-6 py-4">
                                    <button 
                                        onClick={() => onDeleteRow(item.id)}
                                        className="font-medium text-red-600 hover:underline"
                                    >
                                        Hapus
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};


// --- Main App Component ---

function App() {
    const [allData, setAllData] = useState<SalesData[]>([]);
    const [initialStocks, setInitialStocks] = useState<Record<string, number>>({});
    const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Load data from localStorage on initial render
    useEffect(() => {
        try {
            const storedData = localStorage.getItem(LOCAL_STORAGE_KEY_DATA);
            const storedStocks = localStorage.getItem(LOCAL_STORAGE_KEY_STOCK);
            const data = storedData ? JSON.parse(storedData) : [];
            const stocks = storedStocks ? JSON.parse(storedStocks) : {};
            
            setInitialStocks(stocks);

            if(data.length > 0) {
                 const { processedData, error: validationError } = processAndValidateData(data, stocks);
                 if (validationError) {
                     setError(`Data yang tersimpan tidak valid: ${validationError}`);
                     setAllData([]);
                 } else {
                     setAllData(processedData);
                 }
            }

        } catch (e) {
            console.error("Failed to load data from localStorage", e);
            setError("Gagal memuat data. Mungkin data korup.");
        }
    }, []);

    const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target?.result as string;
            const { data: newEntries, error: parseError } = parseCSV(text);
            
            if (parseError) {
                setError(parseError);
                return;
            }

            // --- New logic: Infer initial stocks for new products ---
            const inferredStocks = inferInitialStocks(newEntries, initialStocks);
            const combinedInitialStocks = { ...initialStocks, ...inferredStocks };
            
            const combinedData = [...allData, ...newEntries];
            const { processedData, error: validationError } = processAndValidateData(combinedData, combinedInitialStocks);

            if (validationError) {
                setError(validationError);
            } else {
                setAllData(processedData);
                setInitialStocks(combinedInitialStocks); // Save the updated initial stocks
                localStorage.setItem(LOCAL_STORAGE_KEY_DATA, JSON.stringify(processedData));
                localStorage.setItem(LOCAL_STORAGE_KEY_STOCK, JSON.stringify(combinedInitialStocks));
                setError(null);
            }
        };
        reader.readAsText(file);
        event.target.value = ''; // Reset file input
    };
    
    const handleAddManualEntry = (newEntry: Omit<SalesData, 'id'>) => {
        const combinedData = [...allData, newEntry as SalesData]; // Add temporary ID for processing
        const { processedData, error: validationError } = processAndValidateData(combinedData, initialStocks);
        
        if (validationError) {
            // Return error to be displayed in the form
            return validationError;
        } else {
            setAllData(processedData);
            localStorage.setItem(LOCAL_STORAGE_KEY_DATA, JSON.stringify(processedData));
            setError(null);
            return null; // No error
        }
    };

    const handleUpdateInitialStocks = (newStocks: Record<string, number>) => {
        const { processedData, error: validationError } = processAndValidateData(allData, newStocks);

        if (validationError) {
            setError(`Stok awal tidak valid: ${validationError}`);
        } else {
            setInitialStocks(newStocks);
            setAllData(processedData);
            localStorage.setItem(LOCAL_STORAGE_KEY_STOCK, JSON.stringify(newStocks));
            localStorage.setItem(LOCAL_STORAGE_KEY_DATA, JSON.stringify(processedData));
            setError(null);
        }
    };
    
     const handleDeleteRow = (idToDelete: string) => {
        const filteredData = allData.filter(item => item.id !== idToDelete);
        const { processedData, error: validationError } = processAndValidateData(filteredData, initialStocks);
        
        if (validationError) {
            setError(`Gagal menghapus baris: Aksi ini akan menyebabkan data tidak valid. ${validationError}`);
        } else {
            setAllData(processedData);
            localStorage.setItem(LOCAL_STORAGE_KEY_DATA, JSON.stringify(processedData));
            setError(null);
        }
    };

    const handleClearData = () => {
        if (window.confirm("Apakah Anda yakin ingin menghapus semua data? Aksi ini tidak dapat dibatalkan.")) {
            setAllData([]);
            setInitialStocks({});
            localStorage.removeItem(LOCAL_STORAGE_KEY_DATA);
            localStorage.removeItem(LOCAL_STORAGE_KEY_STOCK);
            setError(null);
        }
    };


    const sortedData = useMemo(() => {
        if (!sortConfig) return allData;
        
        // Fix: Type-safe sorting for properties that can be string or number.
        return [...allData].sort((a, b) => {
            const aValue = a[sortConfig.key];
            const bValue = b[sortConfig.key];

            if (typeof aValue === 'number' && typeof bValue === 'number') {
                return sortConfig.direction === 'ascending' ? aValue - bValue : bValue - aValue;
            }

            if (typeof aValue === 'string' && typeof bValue === 'string') {
                return sortConfig.direction === 'ascending' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
            }

            return 0;
        });
    }, [allData, sortConfig]);

    const { 
        totalPenjualan, 
        totalLaba, 
        produkTerlaris, 
        finalStockLevels 
    } = useMemo(() => {
        const salesByProduct: Record<string, number> = {};
        
        const latestStock: Record<string, SalesData> = {};
        for(const item of allData) {
            if (!latestStock[item.nama_produk] || new Date(item.tanggal) >= new Date(latestStock[item.nama_produk].tanggal)) {
                 latestStock[item.nama_produk] = item;
            }
             if (item.jumlah_terjual > 0) {
                 salesByProduct[item.nama_produk] = (salesByProduct[item.nama_produk] || 0) + item.jumlah_terjual;
             }
        }
        
        // FIX: Explicitly type finalStockLevels to ensure correct type inference.
        const finalStockLevels: Record<string, number> = Object.fromEntries(
            Object.values(latestStock).map(item => [item.nama_produk, item.stok_sisa])
        );

        const totalPenjualan = allData.reduce((acc, item) => acc + item.total_penjualan, 0);
        const totalLaba = allData.reduce((acc, item) => acc + item.laba, 0);

        const produkTerlaris = Object.keys(salesByProduct).length > 0
            ? Object.entries(salesByProduct).reduce((a, b) => a[1] > b[1] ? a : b)[0]
            : 'N/A';
            
        return { totalPenjualan, totalLaba, produkTerlaris, finalStockLevels };
    }, [allData]);
    
    const chartData = useMemo(() => {
        const salesByProduct: Record<string, { totalPenjualan: number; totalLaba: number }> = {};
        allData.forEach(item => {
            if (!salesByProduct[item.nama_produk]) {
                salesByProduct[item.nama_produk] = { totalPenjualan: 0, totalLaba: 0 };
            }
            salesByProduct[item.nama_produk].totalPenjualan += item.total_penjualan;
            salesByProduct[item.nama_produk].totalLaba += item.laba;
        });
        return Object.entries(salesByProduct).map(([name, data]) => ({ name, ...data }));
    }, [allData]);

    const stockStatus = useMemo(() => {
        const safe: { product: string; stock: number }[] = [];
        const low: { product: string; stock: number }[] = [];
        const out: { product: string; stock: number }[] = [];

        for (const [product, stock] of Object.entries(finalStockLevels)) {
            if (stock <= 0) {
                out.push({ product, stock });
            } else if (stock < LOW_STOCK_THRESHOLD) {
                low.push({ product, stock });
            } else {
                safe.push({ product, stock });
            }
        }
        return { safe, low, out };
    }, [finalStockLevels]);

    const uniqueProducts = useMemo(() => {
        return [...new Set(allData.map(d => d.nama_produk))];
    }, [allData]);

    if (allData.length === 0 && Object.keys(initialStocks).length === 0) {
        return (
            <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4">
                <div className="text-center max-w-2xl mx-auto">
                    <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 to-blue-500 mb-4">
                        Selamat Datang di Dashboard ERP Penjualan
                    </h1>
                    <p className="text-slate-600 text-lg mb-8">
                        Mulai dengan mengunggah file CSV data penjualan Anda. Data yang sudah diunggah akan tersimpan di browser Anda.
                    </p>
                    <div className="bg-white p-6 rounded-2xl shadow-lg">
                        <h2 className="text-xl font-bold text-slate-800 mb-3">Panduan Format CSV</h2>
                        <p className="text-slate-600 mb-4">Pastikan file CSV Anda memiliki header berikut (urutan tidak penting):</p>
                        <code className="block text-left bg-slate-100 p-4 rounded-md text-slate-700 overflow-x-auto">
                            tanggal,nama_produk,jumlah_terjual,harga_beli,harga_jual,total_penjualan,total_biaya,laba,stok_sisa
                        </code>
                        <div className="mt-6 flex justify-center gap-4">
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="bg-indigo-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-indigo-700 transition-colors shadow-md"
                            >
                                Unggah File CSV
                            </button>
                             <button
                                onClick={handleClearData}
                                className="bg-red-500 text-white font-bold py-3 px-6 rounded-lg hover:bg-red-600 transition-colors shadow-md"
                            >
                                Hapus Semua Data
                            </button>
                        </div>
                    </div>
                     <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".csv" className="hidden" />
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
            <div className="max-w-7xl mx-auto">
                {/* Header */}
                <header className="mb-8">
                    <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 to-blue-500 mb-2">
                        📊 Dashboard ERP Penjualan
                    </h1>
                    <p className="text-slate-600">Analisis penjualan dan stok produk Anda secara real-time.</p>
                </header>
                
                {error && (
                    <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 mb-6 rounded-r-lg shadow-md" role="alert">
                        <p className="font-bold">Error</p>
                        <p>{error}</p>
                        <button onClick={() => setError(null)} className="absolute top-0 bottom-0 right-0 px-4 py-3">
                            <span className="text-2xl">&times;</span>
                        </button>
                    </div>
                )}


                {/* Main Content Grid */}
                <main className="space-y-6">
                    {/* Summary Cards */}
                    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                        <SummaryCard title="Total Penjualan" value={formatCurrency(totalPenjualan)} icon={<MoneyIcon />} color="bg-blue-100 text-blue-600" />
                        <SummaryCard title="Total Laba" value={formatCurrency(totalLaba)} icon={<ChartBarIcon />} color="bg-green-100 text-green-600" />
                        <SummaryCard title="Produk Terlaris" value={produkTerlaris} icon={<StarIcon />} color="bg-yellow-100 text-yellow-600" />
                        <SummaryCard title="Produk Hampir Habis" value={formatNumber(stockStatus.low.length)} icon={<ArchiveIcon />} color="bg-orange-100 text-orange-600" />
                    </section>
                    
                    {/* Stock Status */}
                    <section className="bg-white p-6 rounded-2xl shadow-lg">
                        <h3 className="text-xl font-bold text-slate-800 mb-4">Status Stok Saat Ini</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            {/* Stok Aman */}
                            <div className="bg-slate-50 p-4 rounded-lg">
                                <h4 className="font-semibold text-green-600 mb-3 border-b border-green-200 pb-2">🟢 Stok Aman (&gt;= {LOW_STOCK_THRESHOLD})</h4>
                                <ul className="space-y-2 text-sm max-h-48 overflow-y-auto pr-2">
                                    {stockStatus.safe.length > 0 ? (
                                        stockStatus.safe.map(item => (
                                            <li key={item.product} className="flex justify-between p-2 bg-green-100 rounded text-green-900">
                                                <span className="font-medium">{item.product}</span>
                                                <span className="font-bold">{formatNumber(item.stock)}</span>
                                            </li>
                                        ))
                                    ) : (
                                        <p className="text-slate-500 italic text-center py-4">Semua produk dalam kondisi aman.</p>
                                    )}
                                </ul>
                            </div>
                            {/* Stok Menipis */}
                             <div className="bg-slate-50 p-4 rounded-lg">
                                <h4 className="font-semibold text-orange-600 mb-3 border-b border-orange-200 pb-2">🟠 Stok Menipis (&lt; {LOW_STOCK_THRESHOLD})</h4>
                                <ul className="space-y-2 text-sm max-h-48 overflow-y-auto pr-2">
                                     {stockStatus.low.length > 0 ? (
                                        stockStatus.low.map(item => (
                                            <li key={item.product} className="flex justify-between p-2 bg-orange-100 rounded text-orange-900">
                                                <span className="font-medium">{item.product}</span>
                                                <span className="font-bold">{formatNumber(item.stock)}</span>
                                            </li>
                                        ))
                                     ) : (
                                        <p className="text-slate-500 italic text-center py-4">Tidak ada produk yang stoknya menipis.</p>
                                     )}
                                </ul>
                            </div>
                             {/* Stok Habis */}
                             <div className="bg-slate-50 p-4 rounded-lg">
                                <h4 className="font-semibold text-red-600 mb-3 border-b border-red-200 pb-2">🔴 Stok Habis</h4>
                                <ul className="space-y-2 text-sm max-h-48 overflow-y-auto pr-2">
                                     {stockStatus.out.length > 0 ? (
                                        stockStatus.out.map(item => (
                                            <li key={item.product} className="flex justify-between p-2 bg-red-100 rounded text-red-900">
                                                <span className="font-medium">{item.product}</span>
                                                <span className="font-bold">{formatNumber(item.stock)}</span>
                                            </li>
                                        ))
                                     ) : (
                                        <p className="text-slate-500 italic text-center py-4">Tidak ada produk yang habis.</p>
                                     )}
                                </ul>
                            </div>
                        </div>
                    </section>


                    {/* Action and Input Grid */}
                    <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div className="space-y-6">
                            <ManualEntryForm onAddEntry={handleAddManualEntry} products={uniqueProducts} initialStocks={initialStocks} />
                             <InitialStockManager initialStocks={initialStocks} onUpdateStocks={handleUpdateInitialStocks} />
                        </div>

                        {/* Charts */}
                        <div className="bg-white p-6 rounded-2xl shadow-lg">
                            <h3 className="text-xl font-bold text-slate-800 mb-4">Grafik Penjualan & Laba per Produk</h3>
                             <ResponsiveContainer width="100%" height={400}>
                                <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                                    <CartesianGrid strokeDasharray="3 3" />
                                    <XAxis dataKey="name" />
                                    <YAxis />
                                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                                    <Legend />
                                    <Bar dataKey="totalPenjualan" fill="#8884d8" name="Total Penjualan" />
                                    <Bar dataKey="totalLaba" fill="#82ca9d" name="Total Laba" />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </section>

                    {/* Data Table */}
                    <section>
                         <DataTable data={sortedData} onSort={setSortConfig} sortConfig={sortConfig} onDeleteRow={handleDeleteRow} />
                    </section>

                     {/* Global Actions */}
                    <section className="mt-8 flex justify-center gap-4">
                         <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".csv" className="hidden" />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="bg-indigo-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-indigo-700 transition-colors shadow-md"
                        >
                            Unggah CSV Baru
                        </button>
                        <button
                            onClick={() => exportToCSV(allData, 'laporan_penjualan.csv')}
                            className="bg-green-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-green-700 transition-colors shadow-md"
                        >
                            Unduh Laporan (CSV)
                        </button>
                        <button
                            onClick={handleClearData}
                            className="bg-red-500 text-white font-bold py-3 px-6 rounded-lg hover:bg-red-600 transition-colors shadow-md"
                        >
                            Hapus Semua Data
                        </button>
                    </section>
                </main>
            </div>
        </div>
    );
}

export default App;