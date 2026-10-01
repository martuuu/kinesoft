import re,html,subprocess,json,string,time
res={}
terms=list('AEIOUSRLNTCMD')+['1','2','3','.',' ','Y','B','P','G','F','V','H','Z','K','W','X','J','Q','Ñ']
for q in terms:
    t=subprocess.run(['curl','-sSL','-m','90','-A','Mozilla/5.0','-X','POST','--data-urlencode','pagina_consulta=','--data-urlencode',f'denominacion_b={q}','--data-urlencode','B1=Buscar','https://www.sssalud.gob.ar/index.php?page=bus_emp_padron&cat=consultas'],capture_output=True).stdout.decode('utf-8','replace')
    rows=re.findall(r'name="rnemp" value=(\d+)\s*>.*?value="([\d-]+)".*?TextoTabla3[^>]*>([^<]*)</td>',t,flags=re.S)
    n0=len(res)
    for code,disp,name in rows: res[code]={'code':code,'disp':disp,'name':re.sub(r'\s+',' ',html.unescape(name)).strip()}
    print(repr(q),len(rows),len(res)-n0,flush=True)
    time.sleep(0.5)
json.dump(res,open('rnemp.json','w'),ensure_ascii=False,indent=1)
print(len(res))
