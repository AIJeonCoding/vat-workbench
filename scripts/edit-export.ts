/** 시연용: 내보낸 검토 결과에서 고객이 확인해 준 내용을 고친 수정본을 만든다. */
import ExcelJS from 'exceljs';

void (async () => {
  const [src, out] = process.argv.slice(2);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(src);
  const ws = wb.getWorksheet('검토결과')!;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const cp = String(row.getCell(4).value);
    if (cp.includes('김밥천국')) {
      row.getCell(9).value = '공제';
      row.getCell(10).value = '일반 사업 매입';
      row.getCell(15).value = '직원 점심 식대로 고객 확인';
    }
    if (cp.includes('꽃집')) {
      row.getCell(9).value = '불공제';
      row.getCell(10).value = '기업업무추진비(접대)';
      row.getCell(15).value = '거래처 개업 축하 화환으로 고객 확인';
    }
  });
  await wb.xlsx.writeFile(out);
  console.log('수정본 생성:', out);
})();
