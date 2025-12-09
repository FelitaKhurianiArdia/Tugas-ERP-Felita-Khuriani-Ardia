
export interface SalesData {
  id: string;
  tanggal: string;
  nama_produk: string;
  jumlah_terjual: number;
  harga_beli: number;
  harga_jual: number;
  total_penjualan: number;
  total_biaya: number;
  laba: number;
  stok_sisa: number;
}

export type SortKey = keyof Omit<SalesData, 'id'>;

export interface SortConfig {
  key: SortKey;
  direction: 'ascending' | 'descending';
}
