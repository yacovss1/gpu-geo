function getCountryId(countryName) {
    let hash = 0;
    for (let i = 0; i < countryName.length; i++) {
        hash = ((hash << 5) - hash) + countryName.charCodeAt(i);
        hash = hash & hash;
    }
    return ((Math.abs(hash) % 9999) + 1);
}

console.log('United States of America:', getCountryId('United States of America'));
console.log('USA:', getCountryId('USA'));
console.log('Canada:', getCountryId('Canada'));
console.log('Mexico:', getCountryId('Mexico'));
console.log('United Kingdom:', getCountryId('United Kingdom'));
console.log('France:', getCountryId('France'));
console.log('Germany:', getCountryId('Germany'));
